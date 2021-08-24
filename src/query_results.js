const GraphHelper = require('./helper');
const helper = new GraphHelper();
const debug = require('debug')('bte:biothings-explorer-trapi:QueryResult');

module.exports = class QueryResult {
  constructor() {
    // Each cachedQueryResult can have multiple cached records.
    // Note that the shape of these cached records is nothing
    // like the shape of queryResult and record. We just cache
    // the minimum data required to be able to build up results
    // when this.getResults() is called.
    this.cachedQueryResults = [];
  }

  _addRemainingCachedQueryResults(previousInputNodeID, results, result, cachedQueryResultIndex = 1) {
    if (cachedQueryResultIndex >= this.cachedQueryResults.length) {
      return results;
    }

    const cachedQueryResult = this.cachedQueryResults[cachedQueryResultIndex];

    cachedQueryResult.get(previousInputNodeID).forEach((cachedRecord, i) => {
      if (i > 0) {
        // Clone deep because we're tracing a forked path, so we want to create
        // an additional result that is separate and independent.
        // Previous input node matched multiple output nodes and/or predicates.
        result = Object.assign({}, result);
        results.push(result);
      }

      result.node_bindings[cachedRecord.inputQueryNodeID] = [
        {
          id: cachedRecord.inputNodeID,
        },
      ];
      result.edge_bindings[cachedRecord.queryEdgeID] = [
        {
          id: cachedRecord.kgEdgeID,
        },
      ];

      this._addRemainingCachedQueryResults(cachedRecord.inputNodeID, results, result, cachedQueryResultIndex + 1);
    });
  }

  getResults() {
    // Note that we're working "backwards" here.
    // For every cached record in the final cached query result, we go
    // "backwards" to trace every path back to the initial input node(s).

    const results = [];

    this.cachedQueryResults[0] &&
      this.cachedQueryResults[0].forEach((cachedRecords, outputNodeID) => {
        cachedRecords.forEach((cachedRecord) => {
          const result = {
            node_bindings: {
              [cachedRecord.inputQueryNodeID]: [
                {
                  id: cachedRecord.inputNodeID,
                },
              ],
              [cachedRecord.outputQueryNodeID]: [
                {
                  id: cachedRecord.outputNodeID,
                },
              ],
            },
            edge_bindings: {
              [cachedRecord.queryEdgeID]: [
                {
                  id: cachedRecord.kgEdgeID,
                },
              ],
            },
            //default score issue #200 - TODO: turn to evaluating module eventually
            score: '1.0',
          };

          results.push(result);

          this._addRemainingCachedQueryResults(cachedRecord.inputNodeID, results, result, 1);
        });
      });

    return results;
  }

  update(queryResult) {
    // Note we're storing the cachedQueryResults backwards, with the last
    // cachedQueryResult corresponding to the first update(queryResult) call.

    debug(`Updating query results now!`);
    let previousOutputNodeIDs;
    if (this.cachedQueryResults.length > 0) {
      const previousCachedQueryResult = this.cachedQueryResults[0];
      previousOutputNodeIDs = new Set(previousCachedQueryResult.keys());
    } else {
      previousOutputNodeIDs = new Set();
    }

    const cachedQueryResult = new Map();

    queryResult.forEach((record) => {
      if (record) {
        const inputNodeID = helper._getInputID(record);
        const outputNodeID = helper._getOutputID(record);
  
        if (this.cachedQueryResults.length === 0 || previousOutputNodeIDs.has(inputNodeID)) {
          let cachedRecordsForOutputNodeID;
          if (cachedQueryResult.has(outputNodeID)) {
            cachedRecordsForOutputNodeID = cachedQueryResult.get(outputNodeID);
          } else {
            cachedRecordsForOutputNodeID = [];
            cachedQueryResult.set(outputNodeID, cachedRecordsForOutputNodeID);
          }
  
          cachedRecordsForOutputNodeID.push({
            inputQueryNodeID: helper._getInputQueryNodeID(record),
            inputNodeID: inputNodeID,
            queryEdgeID: record.$edge_metadata.trapi_qEdge_obj.getID(),
            kgEdgeID: helper._getKGEdgeID(record),
            outputQueryNodeID: helper._getOutputQueryNodeID(record),
            outputNodeID: outputNodeID,
          });
        }
      }
    });

    this.cachedQueryResults.unshift(cachedQueryResult);
  }
};
