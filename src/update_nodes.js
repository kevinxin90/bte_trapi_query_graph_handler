const id_resolver = require('biomedical_id_resolver');
const _ = require('lodash');
const debug = require('debug')('bte:biothings-explorer-trapi:nodeUpdateHandler');

module.exports = class NodesUpdateHandler {
  constructor(qEdges) {
    this.qEdges = qEdges;
  }

  /**
   * @private
   * s
   */
  _getCuries(qEdges) {
    let curies = {};
    qEdges.map((edge) => {
      if (edge.hasInputResolved()) {
        return;
      }
      if (edge.hasInput()) {
        const inputCategories = edge.getSubject().getCategories();
        inputCategories.map((category) => {
          if (!(category in curies)) {
            curies[category] = [];
          }
          curies[category] = [...curies[category], ...edge.getInputCurie()];
        });
      }
    });
    return curies;
  }

  /**
   * Resolve input ids
   * @param {object} curies - each key represents the category, e.g. gene, value is an array of curies.
   */
  async _getEquivalentIDs(curies) {
    // const resolver = new id_resolver.Resolver('biolink');
    // const equivalentIDs = await resolver.resolve(curies);
    const equivalentIDs = await id_resolver.resolveSRI(curies);
    return equivalentIDs;
  }

  async setEquivalentIDs(qEdges) {
    const curies = this._getCuries(this.qEdges);
    if (Object.keys(curies).length === 0) {
      debug(`update nodes based on previous query results!`);
      qEdges.map((edge) => {
        edge.input_equivalent_identifiers = edge.prev_edge.output_equivalent_identifiers;
      });
      return;
    }
    debug(`curies: ${JSON.stringify(curies)}`);
    const equivalentIDs = await this._getEquivalentIDs(curies);
    qEdges.map((edge) => {
      debug(`Edge input curie is ${edge.getInputCurie()}`);
      const edgeEquivalentIDs = Object.keys(equivalentIDs)
        .filter((key) => edge.getInputCurie().includes(key))
        .reduce((res, key) => {
          return { ...res, [key]: equivalentIDs[key] };
        }, {});
      debug(`Edge Equivalent IDs are: ${JSON.stringify(edgeEquivalentIDs)}`);
      if (Object.keys(edgeEquivalentIDs).length > 0) {
        edge.input_equivalent_identifiers = edgeEquivalentIDs;
      }
    });
    return;
  }

  _createEquivalentIDsObject(record) {
    if (record.$output.obj !== undefined) {
      return {
        [record.$output.obj.primaryID]: record.$output.obj,
      };
    } else {
      return;
    }
  }

  /**
   * Update nodes with equivalent ids based on query response.
   * @param {object} queryResult - query response
   */
  update(queryResult) {
    // queryResult.map(record => {
    //     record.$edge_metadata.trapi_qEdge_obj.getOutputNode().updateEquivalentIDs(
    //         this._createEquivalentIDsObject(record)
    //     );
    // })
    queryResult.map((record) => {
      if (
        record &&
        !(record.$output.obj[0].primaryID in record.$edge_metadata.trapi_qEdge_obj.output_equivalent_identifiers)
      ) {
        record.$edge_metadata.trapi_qEdge_obj.output_equivalent_identifiers[record.$output.obj[0].primaryID] =
          record.$output.obj;
      }
    });
  }
};
