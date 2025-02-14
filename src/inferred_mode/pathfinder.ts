import TRAPIQueryHandler from '../index';
import {
  TrapiResponse,
  TrapiQEdge,
  TrapiResult,
  TrapiQueryGraph,
  TrapiQNode,
  TrapiAnalysis,
  QueryHandlerOptions,
  TrapiAuxGraphCollection,
} from '@biothings-explorer/types';
import InferredQueryHandler from './inferred_mode';
import { scaled_sigmoid, inverse_scaled_sigmoid } from '../results_assembly/score';
import * as utils from '@biothings-explorer/utils';
import { LogEntry, StampedLog, Telemetry, removeBioLinkPrefix } from '@biothings-explorer/utils';
import { Debug } from "@biothings-explorer/utils";
import generateTemplates from './pf_template_generator';
import { enrichTrapiResultsWithPfocrFigures } from '../results_assembly/pfocr';
const debug = Debug('bte:biothings-explorer-trapi:pathfinder');

interface ResultAuxObject {
  results: ResultObject;
  graphs: AuxGraphObject;
}

interface ResultObject {
  [id: string]: TrapiResult;
}

interface AuxGraphObject {
  [id: string]: { edges: Set<string> };
}

interface FullGraph {
  [node: string]: { [dst: string]: Set<string> };
}

interface DfsGraph {
  [node: string]: { [dst: string]: boolean };
}

export default class PathfinderQueryHandler {
  logs: StampedLog[];
  CREATIVE_LIMIT: number;
  options: QueryHandlerOptions;
  queryGraph: TrapiQueryGraph;
  parent: TRAPIQueryHandler;

  // assigned internally
  unpinnedNodeId: string;
  unpinnedNode: TrapiQNode;
  intermediateEdges: [string, TrapiQEdge][];
  mainEdgeId: string;
  mainEdge: TrapiQEdge;
  originalAnalyses: { [id: string]: TrapiAnalysis };
  inferredQueryHandler: InferredQueryHandler;

  constructor(logs: StampedLog[], queryGraph: TrapiQueryGraph, parent: TRAPIQueryHandler) {
    this.logs = logs;
    this.options = parent.options;
    this.parent = parent;
    this.queryGraph = queryGraph;
    this.CREATIVE_LIMIT = process.env.CREATIVE_LIMIT ? parseInt(process.env.CREATIVE_LIMIT) : 500;
  }

  async query() {
    // add log for PF mode
    this.logs.push(new LogEntry('INFO', null, 'Proceeding in Pathfinder mode.').getLog());
    debug('Proceeding in Pathfinder mode');

    const err = this.extractData();

    if (typeof err === 'string') {
      debug(err);
      this.logs.push(new LogEntry('WARNING', null, err).getLog());
      return;
    }

    this.fixCategories();

    const templates = await generateTemplates(
      this.queryGraph.nodes[this.mainEdge.subject],
      this.unpinnedNode,
      this.queryGraph.nodes[this.mainEdge.object],
    );

    const logMessage = `Got ${templates.length} pathfinder query templates.`;
    debug(logMessage);
    this.logs.push(new LogEntry('INFO', null, logMessage).getLog());

    // log all the templates
    const templateNames = ['A', 'B', 'C'];
    for (let i = 0; i < 3; i++) {
      let logMessage = `Pathfinder Template ${templateNames[i]}: ${templates[i].log}`;
      debug(logMessage);
      this.logs.push(new LogEntry('INFO', null, logMessage).getLog());
    }

    // handle dry run scenario
    if (this.options.dryrun_pathfinder) {
      return {
        description: `Pathfinder Dry Run completed successfully. No results received. ${templates.length} templates generated.`,
        schema_version: global.SCHEMA_VERSION,
        biolink_version: global.BIOLINK_VERSION,
        workflow: [{ id: this.options.smartAPIID || this.options.teamName ? 'lookup' : 'lookup_and_score' }],
        message: {
          query_graph: this.parent.originalQueryGraph,
          knowledge_graph: this.parent.knowledgeGraph.kg,
          auxiliary_graphs: {},
          results: [],
        },
        logs: this.logs.map((log) => log.toJSON()),
      };
    }

    // remove unpinned node & all edges involving unpinned node for now
    delete this.queryGraph.nodes[this.unpinnedNodeId];

    // remove intermediates for creative execution
    this.intermediateEdges.forEach(([edgeId, _]) => delete this.queryGraph.edges[edgeId]);

    // run creative mode
    this.inferredQueryHandler = new InferredQueryHandler(
      this.parent,
      this.queryGraph,
      this.logs,
      this.options,
      this.parent.path,
      this.parent.predicatePath,
      this.parent.includeReasoner,
      true,
    );
    const creativeResponse = await this.inferredQueryHandler.query(
      templates.map((queryGraph, i) => ({ template: `Template ${i + 1}`, queryGraph, qualifiers: undefined })),
    );

    // restore query graph
    this.queryGraph.nodes[this.unpinnedNodeId] = this.unpinnedNode;
    this.intermediateEdges.forEach(([edgeId, edge]) => (this.queryGraph.edges[edgeId] = edge));
    creativeResponse.message.query_graph = this.queryGraph;

    this.parse(creativeResponse);
    this._pruneKg(creativeResponse);

    // pfocr
    this.logs = [...this.logs, ...(await enrichTrapiResultsWithPfocrFigures(creativeResponse))];

    // logs
    creativeResponse.logs = this.logs.map((log) => log.toJSON());

    return creativeResponse;
  }

  // extracts info from query into variables that are used by pathfinder
  // returns string if an error occurred
  extractData(): undefined | string {
    [this.unpinnedNodeId, this.unpinnedNode] = Object.entries(this.queryGraph.nodes).find(([_, node]) => !node.ids);

    this.intermediateEdges = Object.entries(this.queryGraph.edges).filter(
      ([_, edge]) => edge.subject === this.unpinnedNodeId || edge.object === this.unpinnedNodeId,
    );
    [this.mainEdgeId, this.mainEdge] = Object.entries(this.queryGraph.edges).find(
      ([_, edge]) => edge.subject !== this.unpinnedNodeId && edge.object !== this.unpinnedNodeId,
    );

    // intermediateEdges should be in order of n0 -> un & un -> n1
    if (this.intermediateEdges[0][1].subject === this.unpinnedNodeId) {
      let temp = this.intermediateEdges[0];
      this.intermediateEdges[0] = this.intermediateEdges[1];
      this.intermediateEdges[1] = temp;
    }

    if (
      this.intermediateEdges[0][1].subject !== this.mainEdge.subject ||
      this.intermediateEdges[1][1].object !== this.mainEdge.object ||
      this.intermediateEdges[0][1].object !== this.unpinnedNodeId ||
      this.intermediateEdges[1][1].subject !== this.unpinnedNodeId
    ) {
      return 'Intermediate edges for Pathfinder are incorrect. Should follow pinned node -> unpinned node -> pinned node. Your query terminates.';
    }
  }

  fixCategories() {
    const FALLBACK_ANCESTORS = ['ChemicalEntity'];
    debug('Checking for categories which should have fallback ancestors added...');
    [
      this.queryGraph.nodes[this.mainEdge.subject],
      this.unpinnedNode,
      this.queryGraph.nodes[this.mainEdge.object],
    ].forEach((node, i) => {
      const label = [this.mainEdge.subject, this.unpinnedNodeId, this.mainEdge.object];
      const ancestorsToInject = new Set();
      node.categories.forEach((category) => {
        const ancestors = utils.biolink.getAncestorClasses(removeBioLinkPrefix(category));
        if (!Array.isArray(ancestors)) return;
        ancestors.forEach((ancestor) => {
          if (FALLBACK_ANCESTORS.includes(ancestor)) {
            ancestorsToInject.add(ancestor);
          }
        });
      });
      [...ancestorsToInject].forEach((category) => node.categories.push(`biolink:${category}`));
      if (ancestorsToInject.size > 0) {
      debug(`Added ancestors (${[...ancestorsToInject].join(', ')}) to ${label[i]}.`);
      }
    });
  }

  _pruneKg(creativeResponse: TrapiResponse) {
    if (!this.inferredQueryHandler) {
      this.inferredQueryHandler = new InferredQueryHandler(
        this.parent,
        this.queryGraph,
        this.logs,
        this.options,
        this.parent.path,
        this.parent.predicatePath,
        this.parent.includeReasoner,
        true,
      );
    }
    this.inferredQueryHandler.pruneKnowledgeGraph(creativeResponse);
  }

  parse(creativeResponse: TrapiResponse) {
    const span = Telemetry.startSpan({ description: 'pathfinderParse' });

    this.originalAnalyses = (creativeResponse as any).original_analyses;
    delete (creativeResponse as any).original_analyses;

    // if no results then we are done
    if (creativeResponse.message.results.length === 0) {
      return creativeResponse;
    }

    // set up a graph structure
    const kgEdge = creativeResponse.message.results[0].analyses[0].edge_bindings[this.mainEdgeId][0].id;
    const kgSrc = creativeResponse.message.results[0].node_bindings[this.mainEdge.subject][0].id;
    const kgDst = creativeResponse.message.results[0].node_bindings[this.mainEdge.object][0].id;
    const fullGraph: FullGraph = {};
    const supportGraphsPerNode: { [node: string]: Set<string> } = {};
    const supportGraphs = (creativeResponse.message.knowledge_graph.edges[kgEdge]?.attributes?.find(
      (attr) => attr.attribute_type_id === 'biolink:support_graphs',
    )?.value ?? []) as string[];
    for (const supportGraph of supportGraphs) {
      const auxGraph = (creativeResponse.message.auxiliary_graphs ?? {})[supportGraph];
      for (const subEdge of auxGraph.edges) {
        const kgSubEdge = creativeResponse.message.knowledge_graph.edges[subEdge];
        if (!fullGraph[kgSubEdge.subject]) {
          fullGraph[kgSubEdge.subject] = {};
        }
        if (!fullGraph[kgSubEdge.subject][kgSubEdge.object]) {
          fullGraph[kgSubEdge.subject][kgSubEdge.object] = new Set();
        }
        fullGraph[kgSubEdge.subject][kgSubEdge.object].add(subEdge);

        if (!supportGraphsPerNode[kgSubEdge.subject]) {
          supportGraphsPerNode[kgSubEdge.subject] = new Set();
        }
        supportGraphsPerNode[kgSubEdge.subject].add(supportGraph);
      }
    }

    const message1 = '[Pathfinder]: Performing search for intermediate nodes.';
    debug(message1);
    this.logs.push(new LogEntry('INFO', null, message1).getLog());

    // check acceptable types
    let acceptableTypes: Set<string> = undefined;
    if (this.unpinnedNode.categories && !this.unpinnedNode.categories.includes('biolink:NamedThing')) {
      acceptableTypes = new Set<string>();
      for (const category of this.unpinnedNode.categories) {
        for (const desc of utils.biolink.getDescendantClasses(removeBioLinkPrefix(category))) {
          acceptableTypes.add('biolink:' + desc);
        }
      }
    }

    const { results: newResultObject, graphs: newAuxGraphs } = this._searchForIntermediates(
      creativeResponse,
      supportGraphsPerNode,
      kgSrc,
      kgDst,
      acceptableTypes,
    );

    creativeResponse.message.results = Object.values(newResultObject)
      .sort((a, b) => (b.analyses[0].score ?? 0) - (a.analyses[0].score ?? 0))
      .slice(0, this.CREATIVE_LIMIT);
    creativeResponse.description = `Query processed successfully, retrieved ${creativeResponse.message.results.length} results.`;

    const finalNewAuxGraphs: TrapiAuxGraphCollection = {};
    for (const res in creativeResponse.message.results) {
      for (const eb of Object.values(creativeResponse.message.results[res].analyses[0].edge_bindings)) {
        for (const edge of eb) {
          const auxGraph = creativeResponse.message.knowledge_graph.edges[edge.id].attributes.find(
            (attr) => attr.attribute_type_id === 'biolink:support_graphs',
          )?.value[0];
          finalNewAuxGraphs[auxGraph] = { edges: [], attributes: [] };
          for (const ed of newAuxGraphs[auxGraph].edges) {
            const [st, en] = ed.split('\n');
            finalNewAuxGraphs[auxGraph].edges.push.apply(
              finalNewAuxGraphs[auxGraph].edges,
              Array.from(fullGraph[st][en]),
            );
          }
        }
      }
    }

    Object.assign(creativeResponse.message.auxiliary_graphs!, finalNewAuxGraphs);

    const message2 = `[Pathfinder]: Pathfinder found ${creativeResponse.message.results.length} intermediate nodes and created ${Object.keys(finalNewAuxGraphs).length} support graphs.`;
    debug(message2);
    this.logs.push(new LogEntry('INFO', null, message2).getLog());

    span.finish();

    return creativeResponse;
  }

  _searchForIntermediates(
    creativeResponse: TrapiResponse,
    supportGraphsPerNode: { [node: string]: Set<string> },
    kgSrc: string,
    kgDst: string,
    acceptableTypes: Set<string> = undefined,
  ): ResultAuxObject {
    const span = Telemetry.startSpan({ description: 'pathfinderIntermediateSearch' });

    const newResultObject: ResultObject = {};
    const newAuxGraphs: AuxGraphObject = {};
    for (let analysis of Object.values(this.originalAnalyses)) {
      const dfsGraph: DfsGraph = {};
      for (const subEdge of Object.values(analysis.edge_bindings).map((eb) => eb[0].id)) {
        const kgSubEdge = creativeResponse.message.knowledge_graph.edges[subEdge];
        if (!dfsGraph[kgSubEdge.subject]) {
          dfsGraph[kgSubEdge.subject] = {};
        }
        if (!dfsGraph[kgSubEdge.subject][kgSubEdge.object]) {
          dfsGraph[kgSubEdge.subject][kgSubEdge.object] = true;
        }
      }

      // perform dfs
      const stack = [{ node: kgSrc, path: [kgSrc] }];

      while (stack.length !== 0) {
        const { node, path } = stack.pop()!;

        // continue creating path if we haven't reached end yet
        if (node !== kgDst) {
          for (const neighbor in dfsGraph[node]) {
            if (!path.includes(neighbor)) {
              stack.push({ node: neighbor, path: [...path, neighbor] });
            }
          }
          continue;
        }

        // path to dest too short
        if (path.length <= 2) {
          continue;
        }

        // loop through all intermediate nodes in path to dest
        for (let i = 1; i < path.length - 1; i++) {
          const intermediateNode = path[i];

          // check if the intermediate is of an appropriate type
          if (acceptableTypes) {
            if (
              !creativeResponse.message.knowledge_graph.nodes[intermediateNode].categories.find((x) =>
                acceptableTypes.has(x),
              )
            ) {
              continue;
            }
          }

          if (!(`pathfinder-${kgSrc}-${intermediateNode}-${kgDst}` in newResultObject)) {
            newAuxGraphs[`pathfinder-${kgSrc}-${intermediateNode}-support`] = { edges: new Set() };
            newAuxGraphs[`pathfinder-${intermediateNode}-${kgDst}-support`] = { edges: new Set() };
            newAuxGraphs[`pathfinder-${intermediateNode}-support`] = { edges: new Set() };
          }

          // add "edges" to aux graphs (kg edges will be added later)
          for (let j = 0; j < i; j++) {
            newAuxGraphs[`pathfinder-${kgSrc}-${intermediateNode}-support`].edges.add(`${path[j]}\n${path[j + 1]}`);
            newAuxGraphs[`pathfinder-${intermediateNode}-support`].edges.add(`${path[j]}\n${path[j + 1]}`);
          }
          for (let j = i; j < path.length - 1; j++) {
            newAuxGraphs[`pathfinder-${intermediateNode}-${kgDst}-support`].edges.add(`${path[j]}\n${path[j + 1]}`);
            newAuxGraphs[`pathfinder-${intermediateNode}-support`].edges.add(`${path[j]}\n${path[j + 1]}`);
          }

          // code below is only for new results
          if (`pathfinder-${kgSrc}-${intermediateNode}-${kgDst}` in newResultObject) continue;

          // create new edges & aux graph
          newResultObject[`pathfinder-${kgSrc}-${intermediateNode}-${kgDst}`] = {
            node_bindings: {
              [this.mainEdge.subject]: [{ id: kgSrc, attributes: [] }],
              [this.mainEdge.object]: [{ id: kgDst, attributes: [] }],
              [this.unpinnedNodeId]: [{ id: intermediateNode, attributes: [] }],
            },
            analyses: [
              {
                resource_id: 'infores:biothings-explorer',
                edge_bindings: {
                  [this.mainEdgeId]: [{ id: `pathfinder-${intermediateNode}`, attributes: [] }],
                  [this.intermediateEdges[0][0]]: [{ id: `pathfinder-${kgSrc}-${intermediateNode}`, attributes: [] }],
                  [this.intermediateEdges[1][0]]: [{ id: `pathfinder-${intermediateNode}-${kgDst}`, attributes: [] }],
                },
                score: undefined,
              },
            ],
          };
          creativeResponse.message.knowledge_graph.edges[`pathfinder-${kgSrc}-${intermediateNode}`] = {
            predicate: 'biolink:related_to',
            subject: kgSrc,
            object: intermediateNode,
            sources: [
              {
                resource_id: this.options.provenanceUsesServiceProvider
                  ? 'infores:service-provider-trapi'
                  : 'infores:biothings-explorer',
                resource_role: 'primary_knowledge_source',
              },
            ],
            attributes: [
              {
                attribute_type_id: 'biolink:support_graphs',
                value: [`pathfinder-${kgSrc}-${intermediateNode}-support`],
              },
              { attribute_type_id: 'biolink:knowledge_level', value: 'prediction' },
              { attribute_type_id: 'biolink:agent_type', value: 'computational_model' },
            ],
          };
          creativeResponse.message.knowledge_graph.edges[`pathfinder-${intermediateNode}-${kgDst}`] = {
            predicate: 'biolink:related_to',
            subject: intermediateNode,
            object: kgDst,
            sources: [
              {
                resource_id: this.options.provenanceUsesServiceProvider
                  ? 'infores:service-provider-trapi'
                  : 'infores:biothings-explorer',
                resource_role: 'primary_knowledge_source',
              },
            ],
            attributes: [
              {
                attribute_type_id: 'biolink:support_graphs',
                value: [`pathfinder-${intermediateNode}-${kgDst}-support`],
              },
              { attribute_type_id: 'biolink:knowledge_level', value: 'prediction' },
              { attribute_type_id: 'biolink:agent_type', value: 'computational_model' },
            ],
          };
          creativeResponse.message.knowledge_graph.edges[`pathfinder-${intermediateNode}`] = {
            predicate: 'biolink:related_to',
            subject: kgSrc,
            object: kgDst,
            sources: [
              {
                resource_id: this.options.provenanceUsesServiceProvider
                  ? 'infores:service-provider-trapi'
                  : 'infores:biothings-explorer',
                resource_role: 'primary_knowledge_source',
              },
            ],
            attributes: [
              { attribute_type_id: 'biolink:support_graphs', value: [`pathfinder-${intermediateNode}-support`] },
              { attribute_type_id: 'biolink:knowledge_level', value: 'prediction' },
              { attribute_type_id: 'biolink:agent_type', value: 'computational_model' },
            ],
          };

          // calculate score
          if (supportGraphsPerNode[intermediateNode]?.size > 0) {
            let score: number | undefined = undefined;
            for (const supportGraph of supportGraphsPerNode[intermediateNode]) {
              score = scaled_sigmoid(
                inverse_scaled_sigmoid(score ?? 0) + inverse_scaled_sigmoid(this.originalAnalyses[supportGraph].score),
              );
            }
            newResultObject[`pathfinder-${kgSrc}-${intermediateNode}-${kgDst}`].analyses[0].score = score;
          }
        }
      }
    }

    span.finish();

    return { results: newResultObject, graphs: newAuxGraphs };
  }
}
