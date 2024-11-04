import Debug from 'debug';
import {
  biolink,
  getUnique,
  removeBioLinkPrefix,
  LogEntry,
  StampedLog,
  Telemetry,
  timeoutPromise,
} from '@biothings-explorer/utils';
import async from 'async';
import { getTemplates, MatchedTemplate, TemplateLookup } from './template_lookup';
import { scaled_sigmoid, inverse_scaled_sigmoid } from '../results_assembly/score';
import TRAPIQueryHandler from '../index';
import {
  QueryHandlerOptions,
  TrapiAuxGraphCollection,
  TrapiEdgeBinding,
  TrapiKnowledgeGraph,
  TrapiNodeBinding,
  TrapiQEdge,
  TrapiQNode,
  TrapiQueryGraph,
  TrapiResponse,
  TrapiResult,
  TrapiAnalysis,
} from '@biothings-explorer/types';
import { CompactQualifiers } from '../index';
import { enrichTrapiResultsWithPfocrFigures } from '../results_assembly/pfocr';
const debug = Debug('bte:biothings-explorer-trapi:inferred-mode');

export interface CombinedResponse {
  description?: string;
  workflow?: { id: string }[];
  message: {
    query_graph: TrapiQueryGraph;
    knowledge_graph: TrapiKnowledgeGraph;
    auxiliary_graphs?: TrapiAuxGraphCollection;
    results: {
      [resultID: string]: TrapiResult;
    };
  };
  logs: StampedLog[];
  original_analyses?: {
    [graphId: string]: TrapiAnalysis;
  };
}

export interface CombinedResponseReport {
  querySuccess: number;
  queryHadResults: boolean;
  mergedResults: { [resultID: string]: number };
}

// MatchedTemplate, but with IDs, etc. filled in
export type FilledTemplate = MatchedTemplate;

export default class InferredQueryHandler {
  parent: TRAPIQueryHandler;
  queryGraph: TrapiQueryGraph;
  logs: StampedLog[];
  options: QueryHandlerOptions;
  path: string;
  predicatePath: string;
  includeReasoner: boolean;
  pathfinder: boolean;
  CREATIVE_LIMIT: number;
  CREATIVE_TIMEOUT: number;
  constructor(
    parent: TRAPIQueryHandler,
    queryGraph: TrapiQueryGraph,
    logs: StampedLog[],
    options: QueryHandlerOptions,
    path: string,
    predicatePath: string,
    includeReasoner: boolean,
    pathfinder = false,
  ) {
    this.parent = parent;
    this.queryGraph = queryGraph;
    this.logs = logs;
    this.options = options;
    this.path = path;
    this.predicatePath = predicatePath;
    this.includeReasoner = includeReasoner;
    this.pathfinder = pathfinder;
    this.CREATIVE_LIMIT = process.env.CREATIVE_LIMIT ? parseInt(process.env.CREATIVE_LIMIT) : 500;
    this.CREATIVE_TIMEOUT = process.env.CREATIVE_TIMEOUT_S
      ? parseInt(process.env.CREATIVE_TIMEOUT) * 1000
      : 4.50 * 60 * 1000;
  }

  get queryIsValid(): boolean {
    const nodeMissingCategory = Object.values(this.queryGraph.nodes).some((node) => {
      return !node.categories || node.categories.length === 0;
    });
    if (nodeMissingCategory) {
      const message = 'All nodes in Inferred Mode edge must have categories. Your query terminates.';
      this.logs.push(new LogEntry('WARNING', null, message).getLog());
      debug(message);
      return false;
    }

    const nodeMissingID = !Object.values(this.queryGraph.nodes).some((node) => {
      return node.ids && node.ids.length > 0;
    });
    if (nodeMissingID) {
      const message = 'At least one node in Inferred Mode edge must have at least 1 ID. Your query terminates.';
      this.logs.push(new LogEntry('WARNING', null, message).getLog());
      debug(message);
      return false;
    }

    const edgeMissingPredicate =
      !Object.values(this.queryGraph.edges)[0].predicates ||
      Object.values(this.queryGraph.edges)[0].predicates.length < 1;
    if (edgeMissingPredicate) {
      const message = 'Inferred Mode edge must specify a predicate. Your query terminates.';
      this.logs.push(new LogEntry('WARNING', null, message).getLog());
      debug(message);
      return false;
    }

    const tooManyIDs = Object.values(this.queryGraph.nodes).some((node) => {
      return typeof node.ids !== 'undefined' && node.ids.length > 1;
    });
    if (tooManyIDs && !this.pathfinder) {
      const message = 'Inferred Mode queries with multiple IDs are not supported. Your query terminates.';
      this.logs.push(new LogEntry('WARNING', null, message).getLog());
      debug(message);
      return false;
    }

    const multiplePredicates =
      Object.values(this.queryGraph.edges).reduce((sum, edge) => {
        return edge.predicates ? sum + edge.predicates.length : sum;
      }, 0) > 1;
    if (multiplePredicates) {
      const message = 'Inferred Mode queries with multiple predicates are not supported. Your query terminates.';
      this.logs.push(new LogEntry('WARNING', null, message).getLog());
      debug(message);
      return false;
    }

    if (this.options.smartAPIID || this.options.teamName) {
      const message = 'Inferred Mode on smartapi/team-specific endpoints not supported. Your query terminates.';
      this.logs.push(new LogEntry('WARNING', null, message).getLog());
      debug(message);
      return false;
    }

    return true;
  }

  getQueryParts(): {
    qEdgeID: string;
    qEdge: TrapiQEdge;
    qSubject: TrapiQNode;
    qObject: TrapiQNode;
  } {
    const qEdgeID = Object.keys(this.queryGraph.edges)[0];
    const qEdge = this.queryGraph.edges[qEdgeID];
    const qSubject = this.queryGraph.nodes[qEdge.subject];
    const qObject = this.queryGraph.nodes[qEdge.object];
    return {
      qEdgeID: qEdgeID,
      qEdge: qEdge,
      qSubject: qSubject,
      qObject: qObject,
    };
  }

  async findTemplates(qEdge: TrapiQEdge, qSubject: TrapiQNode, qObject: TrapiQNode): Promise<MatchedTemplate[]> {
    debug('Looking up query Templates');
    const expandedSubject = qSubject.categories.reduce((arr: string[], subjectCategory: string) => {
      return getUnique([...arr, ...biolink.getDescendantClasses(removeBioLinkPrefix(subjectCategory))]);
    }, [] as string[]);
    const expandedPredicates = qEdge.predicates.reduce((arr: string[], predicate: string) => {
      return getUnique([...arr, ...biolink.getDescendantPredicates(removeBioLinkPrefix(predicate))]);
    }, [] as string[]);
    const expandedObject = qObject.categories.reduce((arr: string[], objectCategory: string) => {
      return getUnique([...arr, ...biolink.getDescendantClasses(removeBioLinkPrefix(objectCategory))]);
    }, [] as string[]);
    const qualifierConstraints = (qEdge.qualifier_constraints || []).map((qualifierSetObj) => {
      return Object.fromEntries(
        qualifierSetObj.qualifier_set.map(({ qualifier_type_id, qualifier_value }) => [
          qualifier_type_id,
          qualifier_value,
        ]),
      ) as CompactQualifiers;
    });
    if (qualifierConstraints.length === 0) qualifierConstraints.push({});
    const lookupObjects = expandedSubject.reduce((arr: TemplateLookup[], subjectCategory) => {
      const objectCombos = expandedObject.reduce((arr2: TemplateLookup[], objectCategory) => {
        const qualifierCombos = qualifierConstraints.reduce(
          (arr3: TemplateLookup[], qualifierSet: CompactQualifiers) => [
            ...arr3,
            ...expandedPredicates.map((predicate) => {
              return {
                subject: removeBioLinkPrefix(subjectCategory),
                object: removeBioLinkPrefix(objectCategory),
                predicate: removeBioLinkPrefix(predicate),
                qualifiers: qualifierSet,
              };
            }),
          ],
          [],
        );
        return [...arr2, ...qualifierCombos];
      }, []);
      return [...arr, ...objectCombos];
    }, []);
    const templates = await getTemplates(lookupObjects, this.pathfinder);

    const logMessage = `Got ${templates.length} inferred query templates.`;
    debug(logMessage);
    this.logs.push(new LogEntry('INFO', null, logMessage).getLog());

    if (!templates.length) {
      const logMessage = `No Templates matched your inferred-mode query. Your query terminates.`;
      debug(logMessage);
      this.logs.push(new LogEntry('WARNING', null, logMessage).getLog());
    }

    return templates;
  }

  async createQueries(qEdge: TrapiQEdge, qSubject: TrapiQNode, qObject: TrapiQNode): Promise<FilledTemplate[]> {
    const templates = await this.findTemplates(qEdge, qSubject, qObject);
    // combine creative query with templates
    const subQueries = templates.map(({ template, queryGraph, qualifiers }) => {
      queryGraph.nodes.creativeQuerySubject.categories = [
        ...new Set([...queryGraph.nodes.creativeQuerySubject.categories, ...qSubject.categories]),
      ];
      const creativeQuerySubjectIDs = qSubject.ids ? qSubject.ids : [];
      queryGraph.nodes.creativeQuerySubject.ids = queryGraph.nodes.creativeQuerySubject.ids
        ? [...new Set([...queryGraph.nodes.creativeQuerySubject.ids, ...creativeQuerySubjectIDs])]
        : creativeQuerySubjectIDs;

      queryGraph.nodes.creativeQueryObject.categories = [
        ...new Set([...queryGraph.nodes.creativeQueryObject.categories, ...qObject.categories]),
      ];
      const qEdgeObjectIDs = qObject.ids ? qObject.ids : [];
      queryGraph.nodes.creativeQueryObject.ids = queryGraph.nodes.creativeQueryObject.ids
        ? [...new Set([...queryGraph.nodes.creativeQueryObject.ids, ...qEdgeObjectIDs])]
        : qEdgeObjectIDs;

      if (!queryGraph.nodes.creativeQuerySubject.categories.length) {
        delete queryGraph.nodes.creativeQuerySubject.categories;
      }
      if (!queryGraph.nodes.creativeQueryObject.categories.length) {
        delete queryGraph.nodes.creativeQueryObject.categories;
      }
      if (!queryGraph.nodes.creativeQuerySubject.ids.length) {
        delete queryGraph.nodes.creativeQuerySubject.ids;
      }
      if (!queryGraph.nodes.creativeQueryObject.ids.length) {
        delete queryGraph.nodes.creativeQueryObject.ids;
      }

      return { template, queryGraph, qualifiers };
    });

    return subQueries;
  }

  combineResponse(
    queryNum: number,
    handler: TRAPIQueryHandler,
    qEdgeID: string,
    qEdge: TrapiQEdge,
    combinedResponse: CombinedResponse,
    auxGraphSuffixes: { [inferredEdgeID: string]: number },
    qualifiers?: CompactQualifiers,
  ): CombinedResponseReport {
    const span = Telemetry.startSpan({ description: 'creativeCombineResponse' });
    const newResponse = handler.getResponse();
    const report: CombinedResponseReport = {
      querySuccess: 0,
      queryHadResults: false,
      mergedResults: {},
    };
    let mergedThisTemplate = 0;
    const resultIDsFromPrevious = new Set(Object.keys(combinedResponse.message.results));
    // add non-duplicate nodes
    Object.entries(newResponse.message.knowledge_graph.nodes).forEach(([curie, node]) => {
      if (!(curie in combinedResponse.message.knowledge_graph.nodes)) {
        combinedResponse.message.knowledge_graph.nodes[curie] = node;
      }
    });
    // add non-duplicate edges
    Object.entries(newResponse.message.knowledge_graph.edges).forEach(([recordHash, edge]) => {
      if (!(recordHash in combinedResponse.message.knowledge_graph.edges)) {
        combinedResponse.message.knowledge_graph.edges[recordHash] = edge;
      }
    });
    Object.entries(newResponse.message.auxiliary_graphs ?? {}).forEach(([auxGraphID, auxGraph]) => {
      if (!(auxGraphID in combinedResponse.message.auxiliary_graphs)) {
        combinedResponse.message.auxiliary_graphs[auxGraphID] = auxGraph;
      }
    });

    // modified count used for pathfinder
    const pfIntermediateSet = new Set();

    // add results
    newResponse.message.results.forEach((result) => {
      // get query_ids populated by TRAPIQueryHandler.appendOriginalCuriesToResults
      const subjectBinding: TrapiNodeBinding = { id: result.node_bindings.creativeQuerySubject[0].id, attributes: [] };
      const objectBinding: TrapiNodeBinding = { id: result.node_bindings.creativeQueryObject[0].id, attributes: [] };
      if (result.node_bindings.creativeQuerySubject[0].query_id !== undefined) {
        subjectBinding.query_id = result.node_bindings.creativeQuerySubject[0].query_id;
      }
      if (result.node_bindings.creativeQueryObject[0].query_id !== undefined) {
        objectBinding.query_id = result.node_bindings.creativeQueryObject[0].query_id;
      }

      const translatedResult: TrapiResult = {
        node_bindings: {
          [qEdge.subject]: [subjectBinding],
          [qEdge.object]: [objectBinding],
        },
        analyses: [
          {
            resource_id: result.analyses[0].resource_id,
            edge_bindings: {},
            score: result.analyses[0].score,
          },
        ],
      };

      if (this.pathfinder) {
        for (let [nodeID, bindings] of Object.entries(result.node_bindings)) {
          if (nodeID === 'creativeQuerySubject' || nodeID === 'creativeQueryObject') {
            continue;
          }
          for (const binding of bindings) {
            pfIntermediateSet.add(binding.id);
          }
        }
      }

      const resultCreativeSubjectID = translatedResult.node_bindings[qEdge.subject]
        .map((binding) => binding.id)
        .join(',');
      const resultCreativeObjectID = translatedResult.node_bindings[qEdge.object]
        .map((binding) => binding.id)
        .join(',');
      const resultID = `${resultCreativeSubjectID}-${resultCreativeObjectID}`;

      // Direct edge answers stand on their own (assuming some match criteria), not as an inferred edge.
      // A given one-hop result may bind both matching and non-matching edges
      const oneHop = Object.keys(result.node_bindings).length === 2;
      const resultEdgeID = Object.keys(result.analyses[0].edge_bindings)[0]; // Only useful if direct edge
      const nonMatchingEdges = [];
      let useInferredEdge =
        !oneHop ||
        result.analyses[0].edge_bindings[resultEdgeID]
          .map(({ id }) => {
            // If an edge doesn't match, add it to nonMatchingEdges and return false
            const boundEdge = combinedResponse.message.knowledge_graph.edges[id];
            // Predicate matches or is descendant
            const predicateMatch =
              qEdge.predicates?.some((predicate) => {
                const descendantMatch = biolink
                  .getDescendantPredicates(removeBioLinkPrefix(predicate))
                  .includes(removeBioLinkPrefix(boundEdge.predicate));
                return predicate === boundEdge.predicate || descendantMatch;
              }) ?? false;
            // All query qualifiers (if any) are accounted for (more is fine)
            const qualifierMatch =
              !qEdge.qualifier_constraints ||
              qEdge.qualifier_constraints.length === 0 ||
              qEdge.qualifier_constraints?.some(({ qualifier_set }) => {
                return qualifier_set.every((queryQualifier) => {
                  return (
                    boundEdge.qualifiers?.some((qualifier) => {
                      const typeMatch = queryQualifier.qualifier_type_id === qualifier.qualifier_type_id;
                      let valueMatch: boolean;
                      try {
                        const descendants = queryQualifier.qualifier_value.includes('biolink:')
                          ? biolink.getDescendantPredicates(
                            removeBioLinkPrefix(queryQualifier.qualifier_value as string),
                          )
                          : biolink.getDescendantQualifiers(
                            removeBioLinkPrefix(queryQualifier.qualifier_value as string),
                          );
                        valueMatch =
                          queryQualifier.qualifier_value === qualifier.qualifier_value ||
                          descendants.includes(removeBioLinkPrefix(qualifier.qualifier_value as string));
                      } catch (err) {
                        valueMatch = queryQualifier.qualifier_value === qualifier.qualifier_value;
                      }
                      return typeMatch && valueMatch;
                    }) ?? false
                  );
                });
              });
            if (!(predicateMatch && qualifierMatch)) {
              nonMatchingEdges.push(id);
              return false;
            }
            if (!translatedResult.analyses[0].edge_bindings[qEdgeID]) {
              translatedResult.analyses[0].edge_bindings[qEdgeID] = [];
            }
            translatedResult.analyses[0].edge_bindings[qEdgeID].push({ id, attributes: [] });
            return true;
          })
          .includes(false);

      // If result was one-hop and some edges didn't match, pull them out to put in an inferred edge
      if (oneHop && nonMatchingEdges.length > 0) {
        result.analyses[0].edge_bindings[resultEdgeID] = result.analyses[0].edge_bindings[resultEdgeID].filter(
          ({ id }) => nonMatchingEdges.includes(id),
        );
      }
      if (useInferredEdge) {
        // Create an aux graph using the result and associate it with an inferred Edge
        const inferredEdgeID = `inferred-${resultCreativeSubjectID}-${qEdge.predicates[0].replace(
          'biolink:',
          '',
        )}-${resultCreativeObjectID}`;
        if (!translatedResult.analyses[0].edge_bindings[qEdgeID]) {
          translatedResult.analyses[0].edge_bindings[qEdgeID] = [];
        }
        translatedResult.analyses[0].edge_bindings[qEdgeID].push({ id: inferredEdgeID, attributes: [] });
        if (!combinedResponse.message.knowledge_graph.edges[inferredEdgeID]) {
          combinedResponse.message.knowledge_graph.edges[inferredEdgeID] = {
            subject: resultCreativeSubjectID,
            object: resultCreativeObjectID,
            predicate: qEdge.predicates[0],
            sources: [
              {
                resource_id: this.parent.options.provenanceUsesServiceProvider
                  ? 'infores:service-provider-trapi'
                  : 'infores:biothings-explorer',
                resource_role: 'primary_knowledge_source',
              },
            ],
            attributes: [
              { attribute_type_id: 'biolink:support_graphs', value: [] },
              { attribute_type_id: 'biolink:knowledge_level', value: 'prediction' },
              { attribute_type_id: 'biolink:agent_type', value: 'computational_model' },
            ],
          };
        }
        if (!auxGraphSuffixes[inferredEdgeID]) auxGraphSuffixes[inferredEdgeID] = 0;
        const auxGraphID = `${inferredEdgeID}-support${auxGraphSuffixes[inferredEdgeID]}`;
        auxGraphSuffixes[inferredEdgeID]++;
        // Add qualifiers to edge
        if (
          typeof qualifiers == 'object' &&
          Object.keys(qualifiers).length > 0 &&
          !combinedResponse.message.knowledge_graph.edges[inferredEdgeID].qualifiers
        ) {
          combinedResponse.message.knowledge_graph.edges[inferredEdgeID].qualifiers = Object.entries(qualifiers).map(
            ([qualifierType, qualifierValue]) => ({
              qualifier_type_id: qualifierType,
              qualifier_value: qualifierValue,
            }),
          );
        }

        (combinedResponse.message.knowledge_graph.edges[inferredEdgeID].attributes[0].value as string[]).push(
          auxGraphID,
        );
        combinedResponse.message.auxiliary_graphs[auxGraphID] = {
          edges: Object.values(result.analyses[0].edge_bindings).reduce(
            (arr: string[], bindings: TrapiEdgeBinding[]) => {
              bindings.forEach((binding) => arr.push(binding.id));
              return arr;
            },
            [] as string[],
          ),
          attributes: [],
        };

        if (this.pathfinder) {
          combinedResponse.original_analyses[auxGraphID] = result.analyses[0];
        }
      }

      if (resultID in combinedResponse.message.results) {
        report.mergedResults[resultID] = report.mergedResults[resultID] ? report.mergedResults[resultID] + 1 : 1;
        mergedThisTemplate += 1;
        Object.entries(translatedResult.analyses[0].edge_bindings).forEach(([edgeID, bindings]) => {
          const combinedBindings = combinedResponse.message.results[resultID].analyses[0].edge_bindings[edgeID];
          bindings.forEach((binding) => {
            if (combinedBindings.some((combinedBinding) => combinedBinding.id === binding.id)) return;
            combinedResponse.message.results[resultID].analyses[0].edge_bindings[edgeID].push(binding);
          });
        });

        const resScore = translatedResult.analyses[0].score;
        if (typeof combinedResponse.message.results[resultID].analyses[0].score !== 'undefined') {
          combinedResponse.message.results[resultID].analyses[0].score = resScore
            ? scaled_sigmoid(
              inverse_scaled_sigmoid(combinedResponse.message.results[resultID].analyses[0].score) +
              inverse_scaled_sigmoid(resScore),
            )
            : combinedResponse.message.results[resultID].analyses[0].score;
        } else {
          combinedResponse.message.results[resultID].analyses[0].score = resScore;
        }
      } else {
        combinedResponse.message.results[resultID] = translatedResult;
      }
    });
    // Should always be 0?
    // const mergedWithinTemplate = Object.entries(report.mergedResults).reduce((count, [resultID, merged]) => {
    //   return !resultIDsFromPrevious.has(resultID) ? count + merged : count;
    // }, 0);

    // fix/combine logs
    handler.logs.forEach((log) => {
      log.message = `[Template-${queryNum + 1}]: ${log.message}`;

      combinedResponse.logs.push(log);
    });

    const mergeMessage = [
      `Template Summary: Template-${queryNum + 1} `,
      `returned (${newResponse.message.results.length}) results. `,
      queryNum === 0 ? '' : `(${mergedThisTemplate}) of these were merged with results from previous templates. `,
      `Total result count is ${Object.keys(combinedResponse.message.results).length} `,
      `(increased by ${newResponse.message.results.length - mergedThisTemplate})`,
    ].join('');

    debug(mergeMessage);
    combinedResponse.logs.push(new LogEntry('INFO', null, mergeMessage).getLog());

    if (newResponse.message.results.length) {
      report.queryHadResults = true;
    }
    report.querySuccess = 1;

    span.finish();
    return report;
  }

  pruneKnowledgeGraph(combinedResponse: TrapiResponse): void {
    debug('pruning creative combinedResponse nodes/edges...');
    const edgeBoundNodes: Set<string> = new Set();
    const resultsBoundEdges: Set<string> = new Set();
    const resultBoundAuxGraphs: Set<string> = new Set();

    // Handle nodes and edges bound to results directly
    combinedResponse.message.results.forEach((result) => {
      Object.entries(result.analyses[0].edge_bindings).forEach(([, bindings]) => {
        bindings.forEach((binding) => resultsBoundEdges.add(binding.id));
      });
    });

    // Handle edges bound via auxiliary graphs
    // This will iterate over new edges as they're added
    resultsBoundEdges.forEach((edgeID) => {
      edgeBoundNodes.add(combinedResponse.message.knowledge_graph.edges[edgeID].subject);
      edgeBoundNodes.add(combinedResponse.message.knowledge_graph.edges[edgeID].object);
      combinedResponse.message.knowledge_graph.edges[edgeID].attributes.find(({ attribute_type_id, value }) => {
        if (attribute_type_id === 'biolink:support_graphs') {
          (value as string[]).forEach((auxGraphID) => {
            resultBoundAuxGraphs.add(auxGraphID);
            combinedResponse.message.auxiliary_graphs[auxGraphID].edges.forEach((auxGraphEdgeID) => {
              edgeBoundNodes.add(combinedResponse.message.knowledge_graph.edges[auxGraphEdgeID].subject);
              edgeBoundNodes.add(combinedResponse.message.knowledge_graph.edges[auxGraphEdgeID].object);
              resultsBoundEdges.add(auxGraphEdgeID);
            });
          });
          return true;
        }
      });
    });

    const nodesToDelete = Object.keys(combinedResponse.message.knowledge_graph.nodes).filter(
      (nodeID) => !edgeBoundNodes.has(nodeID),
    );
    nodesToDelete.forEach((unusedBTENodeID) => delete combinedResponse.message.knowledge_graph.nodes[unusedBTENodeID]);
    const edgesToDelete = Object.keys(combinedResponse.message.knowledge_graph.edges).filter(
      (edgeID) => !resultsBoundEdges.has(edgeID),
    );
    edgesToDelete.forEach((unusedEdgeID) => delete combinedResponse.message.knowledge_graph.edges[unusedEdgeID]);
    const auxGraphsToDelete = Object.keys(combinedResponse.message.auxiliary_graphs).filter(
      (auxGraphID) => !resultBoundAuxGraphs.has(auxGraphID),
    );
    auxGraphsToDelete.forEach((unusedAuxGraphID) => delete combinedResponse.message.auxiliary_graphs[unusedAuxGraphID]);
    debug(
      `pruned ${nodesToDelete.length} nodes, ${edgesToDelete.length} edges, ${auxGraphsToDelete.length} auxGraphs from combinedResponse.`,
    );
  }

  async query(subQueries?: FilledTemplate[]): Promise<TrapiResponse> {
    // TODO (eventually) check for flipped predicate cases
    // e.g. Drug -treats-> Disease OR Disease -treated_by-> Drug
    const logMessage = 'Query proceeding in Inferred Mode.';
    debug(logMessage);
    this.logs.push(new LogEntry('INFO', null, logMessage).getLog());

    if (!this.queryIsValid) {
      return;
    }

    const { qEdgeID, qEdge, qSubject, qObject } = this.getQueryParts();
    if (!subQueries) {
      subQueries = await this.createQueries(qEdge, qSubject, qObject);
    }
    const combinedResponse = {
      status: 'Success',
      description: '',
      schema_version: global.SCHEMA_VERSION,
      biolink_version: global.BIOLINK_VERSION,
      workflow: [{ id: 'lookup_and_score' }],
      message: {
        query_graph: this.queryGraph,
        knowledge_graph: {
          nodes: {},
          edges: {},
        },
        auxiliary_graphs: {},
        results: {},
      },
      logs: this.logs,
      ...(this.pathfinder && { original_analyses: {} }),
    } as CombinedResponse;
    // add/combine nodes
    const resultQueries = [];
    let successfulQueries = 0;
    let stop = false;
    const mergedResultsCount: {
      [resultID: string]: number;
    } = {};
    const auxGraphSuffixes: { [inferredEdgeID: string]: number } = {};
    if (global.queryInformation !== null) {
      global.queryInformation.totalRecords = {};
    }

    const completedHandlers = await Promise.all(
      subQueries.map(async ({ template, queryGraph, qualifiers }, i) => {
        const span = Telemetry.startSpan({ description: 'creativeTemplate' });
        span.setData('template', i + 1);
        const handler = new TRAPIQueryHandler(
          { ...this.options, skipPfocr: true, handlerIndex: this.options.handlerIndex ?? i },
          this.path,
          this.predicatePath,
          this.includeReasoner,
        );
        global.queryInformation.totalRecords[i] = 0; // Ensure 0 starting for each template
        handler.setQueryGraph(queryGraph);
        const failedHandlerLogs: { [index: number]: StampedLog[] } = {};
        try {
          await timeoutPromise(handler.query(AbortSignal.timeout(this.CREATIVE_TIMEOUT)), this.CREATIVE_TIMEOUT);
        } catch (error) {
          handler.logs.forEach((log) => {
            log.message = `[Template-${i + 1}]: ${log.message}`;
          });
          failedHandlerLogs[i] = handler.logs;
          const message = `ERROR:  Template-${i + 1} failed due to error ${error}`;
          debug(message);
          handler.logs.push(new LogEntry(`ERROR`, null, message).getLog());
          span.finish();
          return { i, handler, qualifiers, failed: true };
        }
        span.finish();
        return { i, handler, qualifiers };
      }),
    );

    for (const handlerInfo of completedHandlers) {
      const { i, handler, qualifiers, failed } = handlerInfo;
      if (failed) {
        handler.logs.forEach(log => combinedResponse.logs.push(log));
        continue;
      }
      const { querySuccess, queryHadResults, mergedResults } = this.combineResponse(
        i,
        handler,
        qEdgeID,
        qEdge,
        combinedResponse,
        auxGraphSuffixes,
        qualifiers,
      );
      successfulQueries += querySuccess;
      if (queryHadResults) resultQueries.push(i);
      Object.entries(mergedResults).forEach(([result, countMerged]) => {
        mergedResultsCount[result] =
          result in mergedResultsCount ? mergedResultsCount[result] + countMerged : countMerged;
      });
    }

    // log about merged Results
    if (Object.keys(mergedResultsCount).length) {
      // Add 1 for first instance of result (not counted during merging)
      const total =
        Object.values(mergedResultsCount).reduce((sum, count) => sum + count, 0) +
        Object.keys(mergedResultsCount).length;
      const message = `Result Merging Summary: (${total}) inferred-template results were merged into (${Object.keys(mergedResultsCount).length
        }) final results, reducing result count by (${total - Object.keys(mergedResultsCount).length})`;
      debug(message);
      combinedResponse.logs.push(new LogEntry('INFO', null, message).getLog());
    }
    if (Object.keys(combinedResponse.message.results).length) {
      combinedResponse.logs.push(
        new LogEntry(
          'INFO',
          null,
          [
            `Final result count`,
            Object.keys(combinedResponse.message.results).length > this.CREATIVE_LIMIT ? ' (before truncation):' : ':',
            ` ${Object.keys(combinedResponse.message.results).length}`,
          ].join(''),
        ).getLog(),
      );
    }
    const response = combinedResponse as unknown as TrapiResponse;
    // sort records by score
    response.message.results = Object.values(combinedResponse.message.results).sort((a, b) => {
      return b.analyses[0].score - a.analyses[0].score ? b.analyses[0].score - a.analyses[0].score : 0;
    });

    // log about trimming results
    if (response.message.results.length > this.CREATIVE_LIMIT) {
      const message = [
        `Number of results exceeds`,
        `creative result maximum of ${this.CREATIVE_LIMIT} (reaching ${Object.keys(response.message.results).length
        } merged). `,
        `Response will be truncated to top-scoring ${this.CREATIVE_LIMIT} results.`,
      ].join('');
      debug(message);
      combinedResponse.logs.push(new LogEntry(`INFO`, null, message).getLog());
    }

    // trim extra results and prune kg
    response.message.results = response.message.results.slice(0, this.CREATIVE_LIMIT);
    response.description = `Query processed successfully, retrieved ${response.message.results.length} results.`;
    this.pruneKnowledgeGraph(response);

    // add pfocr figures
    if (!this.pathfinder) {
      this.logs = [...this.logs, ...(await enrichTrapiResultsWithPfocrFigures(response))];
    }

    // get the final summary log
    if (successfulQueries) {
      this.parent
        .getSummaryLog(response, response.logs as StampedLog[], resultQueries)
        .forEach((log) => response.logs.push(log));
    }
    if (!this.pathfinder) {
      response.logs = (response.logs as StampedLog[]).map((log) => log.toJSON());
    }

    return response;
  }
}
