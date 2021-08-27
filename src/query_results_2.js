const { keys, toPairs, values, zipObject } = require('lodash');
const GraphHelper = require('./helper');
const helper = new GraphHelper();
const utils = require('./utils');
const debug = require('debug')('bte:biothings-explorer-trapi:QueryResult');

/**
 * @typedef {
 *   $edge_metadata: Object<string, *>,
 *   publications: string[],
 *   relation: string,
 *   source: string,
 *   score: string,
 *   $input: Object<string, *>,
 *   $output: Object<string, *>
 * } Record
 *
 * @typedef {
 *   connected_to: string[],
 *   records: Record[]
 * } EdgeData
 *
 * @typedef {string} QueryEdgeID
 *
 * @typedef {Object.<string, EdgeData>} DataByEdge
 *
 * @typedef {
 *   id: string,
 * } NodeBinding
 *
 * @typedef {
 *   id: string,
 * } EdgeBinding
 *
 * @typedef {
 *   node_bindings: Object.<string, NodeBinding[]>,
 *   edge_bindings: Object.<string, EdgeBinding[]>,
 *   score: string
 * } Result
 */

/**
 * Assemble a list of query results.
 *
 * When we query a bte-trapi server, we see this list
 * in the response as message.results.
 *
 * This class could be renamed something like QueryResultsHandler,
 * because when you create an instance and update it, the actual
 * query results are stored in the _results property.
 */
module.exports = class QueryResult {
  /**
   * Create a QueryResult instance.
   */
  constructor() {
    /**
     * @property {Result[]} _results - list of query results
     * @private
     */
    this._results = [];
  }

  getResults() {
    return this._results;
  }

  /**
   * Transform a collection of records into query result(s).
   * Cache the result(s) so they're ready for getResults().
   *
   * With the new generalized query handling, we can safely
   * assume every call to update contains all the records.
   *
   * @param {DataByEdge} dataByEdge
   * @return {undefined} nothing returned; just cache this._results
   */
  update(dataByEdge) {
    debug(`Updating query results now!`);
    this._results = [];

    const edges = new Set(keys(dataByEdge));
    const edgeCount = edges.size;

    // For every query node, get the primaryIDs that every record
    // touching that query node has in common at that query node.
    const commonPrimaryIDsByQueryNodeID = {};
    let emptyQueryNodeFound = false;
    toPairs(dataByEdge).some(([queryEdgeID, {connected_to, records}]) => {

      // queryEdgeID example: 'e01'

      if (!records || records.length === 0) {
        debug(`query edge ${queryEdgeID} has no records`);

        emptyQueryNodeFound = true;

        // this is like calling break in a for loop
        return true;
      }

      // query node ID example: 'n1'

      const inputQueryNodeID = helper._getInputQueryNodeID(records[0]);
      const outputQueryNodeID = helper._getOutputQueryNodeID(records[0]);

      // primary ID example: 'NCBI:1234'

      const inputPrimaryIDs = new Set(records.map(record => {
        return helper._getInputID(record);
      }));
      if (!commonPrimaryIDsByQueryNodeID[inputQueryNodeID]) {
        // if this is the first one
        commonPrimaryIDsByQueryNodeID[inputQueryNodeID] = inputPrimaryIDs;
      } else {
        // take the intersection. This means we limit to primary IDs common
        // to every record at this query node.
        commonPrimaryIDsByQueryNodeID[inputQueryNodeID] = utils.intersection(
          commonPrimaryIDsByQueryNodeID[inputQueryNodeID], inputPrimaryIDs
        );
      }

      // the following is just the same as above, except for output
      const outputPrimaryIDs = new Set(records.map(record => {
        return helper._getOutputID(record);
      }));
      if (!commonPrimaryIDsByQueryNodeID[outputQueryNodeID]) {
        // if this is the first one
        commonPrimaryIDsByQueryNodeID[outputQueryNodeID] = outputPrimaryIDs;
      } else {
        // take the intersection. This means we limit to primary IDs common
        // to every record at this query node.
        commonPrimaryIDsByQueryNodeID[outputQueryNodeID] = utils.intersection(
          commonPrimaryIDsByQueryNodeID[outputQueryNodeID], outputPrimaryIDs
        );
      }

      if ((commonPrimaryIDsByQueryNodeID[inputQueryNodeID].size === 0) ||
          (commonPrimaryIDsByQueryNodeID[outputQueryNodeID].size === 0)) {
        debug(`at least one query node for ${queryEdgeID} doesn't have compatible records`);
        emptyQueryNodeFound = true;
        return true;
      }
    });

    // If any query node is empty, there will be no results, so we can skip
    // any further processing. Every query node in commonPrimaryIDsByQueryNodeID
    // must have at least one primary ID
    if (emptyQueryNodeFound) {
      return;
    }

    // Later on, we'll just need several IDs from each record,
    // not the entire record. Let's collect those ahead of time.
    const briefRecordsByEdge = toPairs(dataByEdge)
      .reduce((acc, [queryEdgeID, {connected_to, records}]) => {
        acc[queryEdgeID] = records.map((record) => {
          return {
            inputQueryNodeID: helper._getInputQueryNodeID(record),
            outputQueryNodeID: helper._getOutputQueryNodeID(record),
            inputPrimaryID: helper._getInputID(record),
            outputPrimaryID: helper._getOutputID(record),
            kgEdgeID: helper._getKGEdgeID(record),
          };
        });

        return acc;
      }, {});

    const queryNodeIDs = keys(commonPrimaryIDsByQueryNodeID);

    // The values from commonPrimaryIDsByQueryNodeID are an array of sets.
    // Each of those sets represents all the primary IDs that are common
    // to the records touching a specific query node at that query node.
    //
    // Example Data
    // ------------
    //
    // query graph:
    // n0->n1
    // 
    // primaryIDs in records:
    // input output
    // n0a   n1a
    // n0a   n1b
    // n0b   n1a
    // n0b   n1b
    //
    // queryNodeID  commonPrimaryIDs
    // n0           n0a, n0b
    // n1           n1a, n1b
    //  
    // commonPrimaryIDsByQueryNodeID:
    // {
    //   "n0": new Set(["n0a", "n0b"]),
    //   "n1": new Set(["n1a", "n1b"])
    // }
    //
    // the values: [new Set([n0a, n0b]), new Set([n1a, n1b])]
    //
    // For an array of sets, we can take one item from every set
    // to make a single new set. The cartesian product represents
    // every possible such new set.
    //
    // (The specific implementation of cartesian product we're
    // currently using expects arrays instead of sets, so we
    // had to convert sets to arrays, but maybe we should use
    // a different implementation to avoid this conversion.)
    //
    // input: [[n0a, n0b], [n1a, n1b]] ->
    // cartesian product: [[n0a, n1a], [n0a, n1b], [n1a, n1a], [n1a, n1b]]
    this._results = utils.cartesian(
        values(commonPrimaryIDsByQueryNodeID)
          // the implementation we're currently using expects arrays, not sets
          .map(v => Array.from(v))
    )
      // We're mapping every sub-array of this:
      // [[n0a, n1a], [n0a, n1b], [n1a, n1a], [n1a, n1b]]
      //
      // to get this:
      // [
      //   {"n0": "n0a", "n1": "n1a"},
      //   {"n0": "n0a", "n1": "n1b"},
      //   {"n0": "n0b", "n1": "n1a"},
      //   {"n0": "n0b", "n1": "n1b"},
      // ]
      .map(commonPrimaryIDCombo => {
        // [n0a, n1a] -> {"n0": "n0a", "n1": "n1a"}
        return zipObject(queryNodeIDs, commonPrimaryIDCombo);
      })
      // We've now identified all the possible combinations of primary IDs.
      // Next, let's check the records to see which possible combinations
      // have a record for every item in the combination.
      //
      // This is necessary, because even though we checked for common
      // primary IDs at every query node, that check didn't verify that
      // the records with those primary IDs are compatible with each other.
      .map(primaryIDByQueryNodeID => {
        return toPairs(briefRecordsByEdge)
          .reduce((acc, [queryEdgeID, briefRecords]) => {
            const compatibleBriefRecords = briefRecords.filter(({
              inputQueryNodeID, outputQueryNodeID,
              inputPrimaryID, outputPrimaryID,
            }) => {
              return (primaryIDByQueryNodeID[inputQueryNodeID] == inputPrimaryID) &&
                (primaryIDByQueryNodeID[outputQueryNodeID] == outputPrimaryID);
            });

            // Make sure this edge has at least one compatible record.
            // If this were a loop, we could break twice and not even
            // need the next filter step further below.
            if (compatibleBriefRecords.length === 0) {
              return acc;
            }

            // Because of the filter step above, every compatibleBriefRecord
            // in this batch will have the same values for:
            // inputQueryNodeID, outputQueryNodeID, inputPrimaryID, outputPrimaryID
            //
            // However, it is possible to have different values for kgEdgeID, so
            // let's put all of those into a set.
            const kgEdgeIDs = compatibleBriefRecords.reduce((acc, {kgEdgeID}) => {
              acc.add(kgEdgeID);
              return acc;
            }, new Set());

            acc[queryEdgeID] = {
              inputQueryNodeID: compatibleBriefRecords[0].inputQueryNodeID,
              outputQueryNodeID: compatibleBriefRecords[0].outputQueryNodeID,
              inputPrimaryID: compatibleBriefRecords[0].inputPrimaryID,
              outputPrimaryID: compatibleBriefRecords[0].outputPrimaryID,
              kgEdgeIDs
            };

            return acc;
          }, {})
      })
      .filter(infoByEdgeForOneCombo => {
        // Make sure every query graph edge is represented.
        // If a query graph edge had zero valid records,
        // it won't have an entry in infoByEdgeForOneCombo.
        return utils.intersection(
          edges,
          (new Set(keys(infoByEdgeForOneCombo)))
        ).size === edgeCount;
      })
      /**
       * Assemble each query result.
       *
       * infoByEdgeForOneCombo represents one compatible combination of records.
       * This means a collection of records, one per query graph edge, all fit
       * together with each other with inputs and outputs connected
       * as specified by the query graph. But for convenience, instead of full
       * records, we're actually just working with the IDs we need, as collected
       * earlier.
       *
       * @param {Object.<QueryEdgeID, {
       *   inputQueryNodeID: string,
       *   outputQueryNodeID: string,
       *   inputPrimaryID: string,
       *   outputPrimaryID: string,
       *   kgEdgeIDs: Set.<string>
       * }>} infoByEdgeForOneCombo
       * @return {Result}
       */
      .map(infoByEdgeForOneCombo => {
        // default score issue #200 - TODO: turn to evaluating module eventually
        const result = {node_bindings: {}, edge_bindings: {}, score: '1.0'};

        toPairs(infoByEdgeForOneCombo).forEach(([queryEdgeID, {
            inputQueryNodeID, outputQueryNodeID,
            inputPrimaryID, outputPrimaryID,
            kgEdgeIDs
          }], i) => {

          // NOTE: either or both of the following could have been set already
          // when we processed records for another query edge, but that's OK.
          //
          // When two records are linked, the outputPrimaryID for one record
          // will be the same as the inputPrimaryID for the other. Because of
          // that, whichever record was processed here first will have already
          // set the value for result.node_bindings[queryNodeID]. Because every
          // record in infoByEdgeForOneCombo uses the same mappings
          // from queryNodeID to primaryID, there is no conflict. The same logic
          // is also valid for the case of more than two linked records.
          if (!result.node_bindings.hasOwnProperty(inputQueryNodeID)) {
            result.node_bindings[inputQueryNodeID] = [
              {
                id: inputPrimaryID
              },
            ];
          }
          if (!result.node_bindings.hasOwnProperty(outputQueryNodeID)) {
            result.node_bindings[outputQueryNodeID] = [
              {
                id: outputPrimaryID
              },
            ];
          }

          const edge_bindings = result.edge_bindings[queryEdgeID] = [];
          kgEdgeIDs.forEach((kgEdgeID) => {
            edge_bindings.push({
              id: kgEdgeID
            });
          });
        });

        return result;
      });
  }
};
