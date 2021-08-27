const call_api = require('@biothings-explorer/call-apis');
const QEdge2BTEEdgeHandler = require('./qedge2bteedge');
const NodesUpdateHandler = require('./update_nodes');
const debug = require('debug')('bte:biothings-explorer-trapi:batch_edge_query');
const CacheHandler = require('./cache_handler');
const utils = require('./utils');
const LogEntry = require('./log_entry');

module.exports = class BatchEdgeQueryHandler {
  constructor(kg, resolveOutputIDs = true, options) {
    this.kg = kg;
    this.subscribers = [];
    this.logs = [];
    this.caching = options && options.caching;
    this.resolveOutputIDs = resolveOutputIDs;
  }

  /**
   * @param {Array} qEdges - an array of TRAPI Query Edges;
   */
  setEdges(qEdges) {
    this.qEdges = qEdges;
  }

  /**
   *
   */
  getEdges() {
    return this.qEdges;
  }

  /**
   * @private
   */
  _expandBTEEdges(bteEdges) {
    // debug(`BTE EDGE ${JSON.stringify(this.qEdges)}`);
    return bteEdges;
  }

  /**
   * @private
   */
  async _queryBTEEdges(bteEdges) {
    let executor = new call_api(bteEdges);
    const res = await executor.query(this.resolveOutputIDs);
    this.logs = [...this.logs, ...executor.logs];
    return res;
  }

  /**
   * @private
   */
  async _postQueryFilter(response) {
    let filters_applied = new Set();
    try {
      const filtered = response.filter((item) => {
        if (
          'predicate' in item['$edge_metadata']['trapi_qEdge_obj']['qEdge'] &&
          'expanded_predicates' in item['$edge_metadata']['trapi_qEdge_obj']['qEdge']
        ) {
          let edge_predicate = item['$edge_metadata']['predicate'];
          let predicate_filters = [];
          predicate_filters = item['$edge_metadata']['trapi_qEdge_obj']['qEdge']['expanded_predicates'];
          if (predicate_filters) {
            //add query predicate to the expanded list
            predicate_filters.concat(edge_predicate);
            predicate_filters.forEach((f) => filters_applied.add(f));
            //remove prefix from filter list to match predicate name format
            predicate_filters = predicate_filters.map((item) => utils.removeBioLinkPrefix(item));
            //compare edge predicate to filter list
            if (predicate_filters.includes(edge_predicate)) {
              return item;
            }
          } else {
            // No predicate restriction on this edge, just add to results
            return item;
          }
        } else {
          // No predicate restriction on this edge, just add to results
          return item;
        }
      });
      // filter result
      debug(`Filters applied to search: ${JSON.stringify([...filters_applied])}`);
      this.logs.push(
        new LogEntry(
          'DEBUG',
          null,
          `query_graph_handler: Post-query predicate restrictions: ${JSON.stringify([...filters_applied])}.`,
        ).getLog(),
      );
      // filter result
      debug(`Filtered results from ${response.length} down to ${filtered.length} results`);
      this.logs.push(
        new LogEntry(
          'DEBUG',
          null,
          `query_graph_handler: Successfully applied post-query predicate restriction: ${response.length} down to ${filtered.length} results.`,
        ).getLog(),
      );
      return filtered;
    } catch (error) {
      // in case of rare failure return all
      debug(`Failed to filter ${response.length} results due to ${error}`);
      return response;
    }
  }

  async query(qEdges) {
    debug('Node Update Start');
    const nodeUpdate = new NodesUpdateHandler(qEdges);
    await nodeUpdate.setEquivalentIDs(qEdges);
    debug('Node Update Success');
    const cacheHandler = new CacheHandler(qEdges, this.caching);
    const { cachedResults, nonCachedEdges } = await cacheHandler.categorizeEdges(qEdges);
    this.logs = [...this.logs, ...cacheHandler.logs];
    let query_res;

    if (nonCachedEdges.length === 0) {
      query_res = [];
    } else {
      debug('Start to convert qEdges into BTEEdges....');
      const edgeConverter = new QEdge2BTEEdgeHandler(nonCachedEdges, this.kg);
      const bteEdges = edgeConverter.convert(nonCachedEdges);
      debug(`qEdges are successfully converted into ${bteEdges.length} BTEEdges....`);
      this.logs = [...this.logs, ...edgeConverter.logs];
      if (bteEdges.length === 0 && cachedResults.length === 0) {
        return [];
      }
      const expanded_bteEdges = this._expandBTEEdges(bteEdges);
      debug('Start to query BTEEdges....');
      query_res = await this._queryBTEEdges(expanded_bteEdges);
      debug('BTEEdges are successfully queried....');
      await cacheHandler.cacheEdges(query_res);
    }
    query_res = [...query_res, ...cachedResults];
    const processed_query_res = await this._postQueryFilter(query_res);
    debug(`Total number of response is ${processed_query_res.length}`);
    debug('Start to update nodes,hi.');
    nodeUpdate.update(processed_query_res);
    debug('update nodes completed');
    return processed_query_res;
  }

  async query_2(qEdges) {
    debug('Node Update Start');
    //it's now a single edge but convert to arr to simplify refactoring
    qEdges = Array.isArray(qEdges) ? qEdges : [qEdges];
    const nodeUpdate = new NodesUpdateHandler(qEdges);
    //difference is there is no previous edge info anymore
    await nodeUpdate.setEquivalentIDs_2(qEdges);
    debug('Node Update Success');
    const cacheHandler = new CacheHandler(qEdges);
    const { cachedResults, nonCachedEdges } = await cacheHandler.categorizeEdges(qEdges);
    this.logs = [...this.logs, ...cacheHandler.logs];
    let query_res;

    if (nonCachedEdges.length === 0) {
      query_res = [];
    } else {
      debug('Start to convert qEdges into BTEEdges....');
      const edgeConverter = new QEdge2BTEEdgeHandler(nonCachedEdges, this.kg);
      const bteEdges = edgeConverter.convert(nonCachedEdges);
      debug(`qEdges are successfully converted into ${bteEdges.length} BTEEdges....`);
      this.logs = [...this.logs, ...edgeConverter.logs];
      if (bteEdges.length === 0 && cachedResults.length === 0) {
        return [];
      }
      const expanded_bteEdges = this._expandBTEEdges(bteEdges);
      debug('Start to query BTEEdges....');
      query_res = await this._queryBTEEdges(expanded_bteEdges);
      debug('BTEEdges are successfully queried....');
      await cacheHandler.cacheEdges(query_res);
    }
    query_res = [...query_res, ...cachedResults];
    const processed_query_res = await this._postQueryFilter(query_res);
    debug(`Total number of response is ${processed_query_res.length}`);
    debug('Start to update nodes,hi.');
    nodeUpdate.update(processed_query_res);
    debug('update nodes completed');
    return processed_query_res;
  }

  /**
   * Register subscribers
   * @param {object} subscriber
   */
  subscribe(subscriber) {
    this.subscribers.push(subscriber);
  }

  /**
   * Unsubscribe a listener
   * @param {object} subscriber
   */
  unsubscribe(subscriber) {
    this.subscribers = this.subscribers.filter((fn) => {
      if (fn != subscriber) return fn;
    });
  }

  /**
   * Nofity all listeners
   */
  notify(res) {
    this.subscribers.map((subscriber) => {
      subscriber.update(res);
    });
  }
};
