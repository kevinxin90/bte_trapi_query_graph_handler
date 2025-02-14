import axios from 'axios';
import { Debug } from "@biothings-explorer/utils";
const debug = Debug('bte:biothings-explorer-trapi:pfocr');
import _ from 'lodash';
import { LogEntry, StampedLog, intersection, biolink, toArray, removeBioLinkPrefix } from '@biothings-explorer/utils';
import { TrapiResult, TrapiKGNode, TrapiResponse, TrapiKGEdge } from '@biothings-explorer/types';
import Graph from '../graph/graph';

// The minimum acceptable number of nodes for a figure to match
// in a TRAPI result and in a PFOCR figure.
const MATCHABLE_NODE_MIN = 2;

// Max number of figures per result
const FIGURE_COUNT_MAX = 20;

// Prefixes that can be searched against PFOCR
// Map supported prefixes as they appear in PFOCR to 'proper' form
const SUPPORTED_PREFIXES = {
  ncbigene: 'NCBIGene',
  doid: 'DOID',
  mesh: 'MESH',
  chebi: 'CHEBI',
};

// Supported top-level types and their mappings to PFOCR fields
// Must be top-level possible for biolink ancestry comparison
const SUPPORTED_TYPES = {
  Gene: 'genes',
  ChemicalEntity: 'chemicals',
  DiseaseOrPhenotypicFeature: 'diseases',
};

interface pfocrQueryBody {
  q: string[];
  scopes: string[];
  fields: string[];
  size: number;
  with_total: boolean;
  from?: number;
}

interface FigureResult {
  query: string;
  _id: string;
  _score: number;
  notfound?: boolean;
  associatedWith: {
    figureUrl: string;
    pfocrUrl: string;
    pmc: string;
    mentions: {
      [type: string]: {
        [prefix: string]: string[]; // list of IDs
      };
    };
  };
}

interface FiguresByQuery {
  [query: string]: FigureResult[];
}

/* Get all results by using a scrolling query
 * https://docs.mygene.info/en/latest/doc/query_service.html#scrolling-queries
 * Using new POST scrolling behavior here:
 * https://github.com/newgene/biothings.api/pull/52
 * All queries must include size: 1000, with_total: true
 * Subsequent queries must use `from` to designate a starting point
 */
async function getAllByScrolling(
  baseUrl: string,
  queryBody: pfocrQueryBody,
  batchIndex: number,
  hits: FigureResult[] = [],
): Promise<FigureResult[]> {
  queryBody.from = batchIndex;
  let data: { hits: FigureResult[]; max_total: number };
  try {
    data = (await axios.post(baseUrl, queryBody, { timeout: 15000 })).data;
  } catch (err) {
    debug(`Error in scrolling request window ${batchIndex}-${batchIndex + 1000}, error is ${(err as Error).message}`);
  }

  if (data) {
    hits.push(...data.hits);
    debug(
      `Batch window ${batchIndex}-${batchIndex + 1000}: ${data.hits.filter((hit) => !hit.notfound).length} hits retrieved for PFOCR figure data`,
    );
  }

  if (data && batchIndex + 1000 < data.max_total) {
    return await getAllByScrolling(baseUrl, queryBody, batchIndex + 1000, hits);
  } else {
    return hits;
  }
}

// Combine query terms in acceptable batch sizes
// Then sort figure results by query term
async function getPfocrFigures(qTerms: string[]): Promise<FiguresByQuery> {
  debug(`Getting PFOCR figure data`);
  const url = {
    dev: 'https://biothings.ci.transltr.io/pfocr/query',
    ci: 'https://biothings.ci.transltr.io/pfocr/query',
    test: 'https://biothings.test.transltr.io/pfocr/query',
    prod: 'https://biothings.ncats.io/pfocr/query',
  }[process.env.INSTANCE_ENV ?? 'prod'];

  const figureResults: FigureResult[] = [];
  await Promise.all(
    _.chunk(qTerms, 100).map(async (qTermBatch) => {
      const queryBody = {
        q: qTermBatch,
        scopes: [],
        fields: [
          '_id',
          'associatedWith.pmc',
          'associatedWith.figureUrl',
          'associatedWith.pfocrUrl',
          'associatedWith.mentions',
        ],
        size: 1000,
        with_total: true,
      };

      figureResults.push(...(await getAllByScrolling(url, queryBody, 0)));
    }),
  ).catch((err) => {
    debug('Error getting PFOCR figures (getPfocrFigures)', err);
    throw err;
  });

  return figureResults.reduce((figuresByQuery: FiguresByQuery, figureResult) => {
    if (!figuresByQuery[figureResult.query]) figuresByQuery[figureResult.query] = [];
    if (!figureResult.notfound) figuresByQuery[figureResult.query].push(figureResult);
    return figuresByQuery;
  }, {});
}

// Results bind nodes, but bound edges may recursively use support graphs which reference other nodes
// Traverse result recursively (using stack) and return all related nodes
function traverseResultForNodes(result: TrapiResult, response: TrapiResponse): Set<TrapiKGNode> {
  const kg = response.message.knowledge_graph;
  const nodes: Set<TrapiKGNode> = new Set();
  const edgeStack: TrapiKGEdge[] = [];
  Object.values(result.node_bindings).forEach((bindings) =>
    bindings.forEach((binding) => nodes.add(kg.nodes[binding.id])),
  );
  Object.values(result.analyses[0].edge_bindings).forEach((bindings) =>
    bindings.forEach((binding) => edgeStack.push(kg.edges[binding.id])),
  );

  while (edgeStack.length > 0) {
    const edge = edgeStack.pop();
    nodes.add(kg.nodes[edge.object]);
    nodes.add(kg.nodes[edge.subject]);
    const supportGraphs = edge.attributes.find((attribute) => attribute.attribute_type_id == 'biolink:support_graphs');
    if (supportGraphs) {
      (supportGraphs.value as string[]).forEach((auxGraphID) =>
        response.message.auxiliary_graphs[auxGraphID].edges.forEach((edgeID) => edgeStack.push(kg.edges[edgeID])),
      );
    }
  }

  return nodes;
}

function generateQterms(response: TrapiResponse): {
  qTerms: string[];
  qTermByResults: Map<TrapiResult, string>;
  primaryCuriebyCurie: Map<string, string>;
} {
  const results = response.message.results;

  const qTermByResults: Map<TrapiResult, string> = new Map();
  const primaryCuriebyCurie: Map<string, string> = new Map();
  const qTerms = results.reduce((qTerms: string[], result: TrapiResult) => {
    const nodes: Set<TrapiKGNode> = new Set();
    const primaryCurieByNode: Map<TrapiKGNode, string> = new Map();
    Object.values(result.node_bindings).forEach((bindings) =>
      bindings.forEach((binding) => {
        const node = response.message.knowledge_graph.nodes[binding.id];
        nodes.add(node);
        primaryCurieByNode.set(node, binding.id);
        primaryCuriebyCurie.set(binding.id, binding.id); // Ensure self-primary relationship
      }),
    );

    // Generate sets per supported node of supported curies
    const nodeSets: Set<string>[] = [];
    const nodeTypes: string[] = [];
    [...nodes].forEach((node) => {
      let supportedCategory = toArray(biolink.getAncestorClasses(removeBioLinkPrefix(node.categories[0]))).find(
        (category) => typeof SUPPORTED_TYPES[category] !== 'undefined',
      );
      if (!supportedCategory) return;

      const supportedEquivalents: Set<string> = new Set();
      const equivalentCuries =
        (node.attributes?.find((attribute) => attribute.attribute_type_id === 'biolink:xref')?.value as string[]) ?? [];
      equivalentCuries.forEach((curie) => {
        primaryCuriebyCurie.set(curie, primaryCurieByNode.get(node)); // Keep track of primary for later use

        const prefix = curie.split(':')[0];
        if (supportedCategory && Object.keys(SUPPORTED_PREFIXES).includes(prefix.toLowerCase())) {
          supportedEquivalents.add(curie);
        }
      });
      if (supportedEquivalents.size === 0) return; // Node has no supported curies

      nodeSets.push(supportedEquivalents);
      nodeTypes.push(SUPPORTED_TYPES[supportedCategory]);
    });

    if (nodeSets.length < MATCHABLE_NODE_MIN) return qTerms; // Result doesn't have enough matchable nodes

    // Generate qTerm for result
    const qTermParts: string[] = [];
    nodeSets.forEach((nodeSet, i) => {
      // Separate by prefix for minimal formatting
      const idsByPrefix: { [prefix: string]: string[] } = {};
      const nodeType = nodeTypes[i];
      nodeSet.forEach((curie) => {
        const prefix = curie.split(':')[0];
        const suffix = curie.replace(`${prefix}:`, '');
        if (!idsByPrefix[prefix]) idsByPrefix[prefix] = [];
        idsByPrefix[prefix].push(suffix);
      });

      const orClause: string[] = [];

      Object.entries(idsByPrefix).forEach(([prefix, ids]) => {
        orClause.push(`associatedWith.mentions.${nodeType}.${[prefix.toLowerCase()]}:(${ids.join(' OR ')})`);
      });

      qTermParts.push(`(${orClause.join(' OR ')})`);
    });

    const qTerm = qTermParts.join(' AND ');
    qTerms.push(qTerm);
    qTermByResults.set(result, qTerm);

    return qTerms;
  }, []);

  return { qTerms, qTermByResults, primaryCuriebyCurie };
}

export async function enrichTrapiResultsWithPfocrFigures(response: TrapiResponse): Promise<StampedLog[]> {
  // NOTE: This function operates on the actual TRAPI information that will be returned
  // to the client. Don't mutate what shouldn't be mutated!

  const results = response.message.results;
  const logs: StampedLog[] = [];

  const { qTerms, qTermByResults, primaryCuriebyCurie } = generateQterms(response);

  if (qTerms.length < 1) {
    // No TRAPI result can satisfy MATCH_COUNT_MIN
    logs.push(new LogEntry('DEBUG', null, 'No result matches criteria, skipping PFOCR figure enrichment.').getLog());
    return logs;
  }

  let figures: FiguresByQuery;
  try {
    figures = await getPfocrFigures(qTerms);
  } catch (err) {
    debug('Error getting PFOCR figures (enrichTrapiResultsWithPfocrFigures)', (err as Error).message);
    logs.push(
      new LogEntry(
        'WARNING',
        null,
        `Error getting PFOCR figures, results will not be enriched. The error is ${err.message}`,
      ).getLog(),
    );
  }
  if (!figures) return logs;

  // Metrics
  const dedupedFigures: { [figureUrl: string]: FigureResult } = {};
  const matchedFigures: Set<string> = new Set();
  const matchedResults: Set<TrapiResult> = new Set();
  let resultsWithTruncatedFigures = 0;
  const truncatedFigures: Set<string> = new Set();

  // Get all supported curies from every figure. Store as curies to avoid collisions/other issues
  const curiesByFigure: { [figureUrl: string]: Set<string> } = {};
  const allCuriesInAllFigures = Object.values(figures).reduce((set, figureSet) => {
    figureSet.forEach((figure) => {
      if (dedupedFigures[figure.associatedWith.figureUrl]) return; // Already handled

      dedupedFigures[figure.associatedWith.figureUrl] = figure;
      const figureCuries = new Set<string>();
      Object.entries(figure.associatedWith.mentions).forEach(([type, prefixes]) => {
        if (!Object.values(SUPPORTED_TYPES).includes(type)) return;

        Object.entries(prefixes).forEach(([prefix, ids]) => {
          prefix = SUPPORTED_PREFIXES[prefix];
          if (!prefix) return;
          ids.forEach((id) => figureCuries.add(`${prefix}:${id}`));
        });
      });
      figureCuries.forEach((curie) => set.add(curie));
      curiesByFigure[figure.associatedWith.figureUrl] = figureCuries;
    });
    return set;
  }, new Set<string>());

  debug(
    `${Object.keys(dedupedFigures).length} PFOCR figures match at least ${MATCHABLE_NODE_MIN} nodes from any TRAPI result`,
  );

  // Iterate over results and grab figures, scoring figures and then truncating
  results.forEach((result) => {
    const resultFigures = figures[qTermByResults.get(result)];
    if (!resultFigures) return;

    const resultNodes = traverseResultForNodes(result, response);
    const resultCuries: Set<string> = [...resultNodes].reduce((curies, node) => {
      const equivalentCuries =
        (node.attributes?.find((attribute) => attribute.attribute_type_id === 'biolink:xref')?.value as string[]) ?? [];
      equivalentCuries.forEach((curie) => {
        const prefix = curie.split(':')[0];
        const suffix = curie.replace(`${prefix}:`, '');
        if (Object.keys(SUPPORTED_PREFIXES).includes(prefix.toLowerCase())) curies.add(curie);
      });
      return curies;
    }, new Set<string>());
    const resultCuriesInAllFigures = intersection(allCuriesInAllFigures, resultCuries);

    resultFigures.forEach((figure) => {
      const figureCuries = curiesByFigure[figure.associatedWith.figureUrl];
      const resultCuriesInFigure = intersection(resultCuries, figureCuries);

      const precision = resultCuriesInFigure.size / figureCuries.size;
      const recall = resultCuriesInFigure.size / resultCuriesInAllFigures.size;

      const matchedCuries = new Set<string>();
      resultCuriesInFigure.forEach((curie) => {
        let primary = primaryCuriebyCurie.get(curie);
        if (primary) {
          matchedCuries.add(primary);
          return;
        }
        // Didn't match, so it's from a node used in an aux graph somewhere
        // Thankfully, this is an edge case, and the search space is already pretty small
        // So performance hit should be minimal in the vast majority of cases
        [...resultNodes].find((node) => {
          const equivalentCuries =
            (node.attributes?.find((attribute) => attribute.attribute_type_id === 'biolink:xref')?.value as string[]) ??
            [];
          if (equivalentCuries.includes(curie)) {
            matchedCuries.add(equivalentCuries[0]); // First equivalent is always the primary
            return true;
          }
        });
      });

      if (!('pfocr' in result)) result.pfocr = [];
      result.pfocr.push({
        // TODO: do we want to include figure title? Note: this would need to be added to queryBody.
        //title: figure.associatedWith.title,
        figureUrl: figure.associatedWith.figureUrl,
        pfocrUrl: figure.associatedWith.pfocrUrl,
        pmc: figure.associatedWith.pmc,
        matchedCuries: [...resultCuriesInFigure],
        matchedKGNodes: [...matchedCuries],
        score: 2 * ((precision * recall) / (precision + recall)),
      });
      matchedResults.add(result);
    });

    if (!result.pfocr) return logs; // Result had no figures

    // Sort by score and cut down to top 20
    const sortedFigures = result.pfocr.sort((figA, figB) => {
      return figB.score - figA.score;
    });

    if (sortedFigures.length > FIGURE_COUNT_MAX) {
      resultsWithTruncatedFigures += 1;
      sortedFigures.slice(0, 20).forEach((figure) => truncatedFigures.add(figure.figureUrl));
      result.pfocr = sortedFigures.slice(0, 20);
    }

    result.pfocr.map((figure) => matchedFigures.add(figure.figureUrl));
  });

  // Each of the matched figures has at least one TRAPI result with a 2+ node overlap of curies with the figure.
  // Each of the matched TRAPI results has at least one figure with curies from 2+ of its bound nodes.
  const unusedFigures = [...truncatedFigures].filter((figureUrl) => !matchedFigures.has(figureUrl)).length;
  let message = `${resultsWithTruncatedFigures} results had pfocr figures truncated to max of 20 (${truncatedFigures.size} unique figures removed, ${unusedFigures} not appearing elsewhere in results).`;
  debug(message);
  logs.push(new LogEntry('DEBUG', null, message).getLog());

  message = `${matchedResults.size} results successfully enriched with ${matchedFigures.size} unique PFOCR figures.`;
  debug(message);
  logs.push(new LogEntry('INFO', null, message).getLog());

  return logs;
}
