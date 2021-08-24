const kg_edge = require('./kg_edge');
const kg_node = require('./kg_node');
const helper = require('../helper');
const debug = require('debug')('bte:biothings-explorer-trapi:Graph');

module.exports = class Graph {
  constructor() {
    this.nodes = {};
    this.edges = {};
    this.paths = {};
    this.helper = new helper();
    this.subscribers = [];
  }

  update(queryResult) {
    debug(`Updating BTE Graph now.`);
    const bteAttributes = ['name', 'label', 'id', 'api', 'provided_by', 'publications'];
    queryResult.map((record) => {
      if (record) {
        const inputPrimaryID = this.helper._getInputID(record);
        const inputQGID = this.helper._getInputQueryNodeID(record);
        const inputID = inputPrimaryID + '-' + inputQGID;
        const outputPrimaryID = this.helper._getOutputID(record);
        const outputQGID = this.helper._getOutputQueryNodeID(record);
        const outputID = outputPrimaryID + '-' + outputQGID;
        const edgeID = this.helper._getKGEdgeID(record);
        if (!(outputID in this.nodes)) {
          this.nodes[outputID] = new kg_node(outputID, {
            primaryID: outputPrimaryID,
            qgID: outputQGID,
            equivalentIDs: this.helper._getOutputEquivalentIds(record),
            names: this.helper._getOutputNames(record),
            label: this.helper._getOutputLabel(record),
            category: this.helper._getOutputCategory(record),
            nodeAttributes: this.helper._getOutputAttributes(record),
          });
        }
        if (!(inputID in this.nodes)) {
          this.nodes[inputID] = new kg_node(inputID, {
            primaryID: inputPrimaryID,
            qgID: inputQGID,
            equivalentIDs: this.helper._getInputEquivalentIds(record),
            names: this.helper._getInputNames(record),
            label: this.helper._getInputLabel(record),
            category: this.helper._getInputCategory(record),
            nodeAttributes: this.helper._getInputAttributes(record),
          });
        }
        this.nodes[outputID].addSourceNode(inputID);
        this.nodes[outputID].addSourceQGNode(inputQGID);
        this.nodes[inputID].addTargetNode(outputID);
        this.nodes[inputID].addTargetQGNode(outputQGID);
        if (!(edgeID in this.edges)) {
          this.edges[edgeID] = new kg_edge(edgeID, {
            predicate: this.helper._getPredicate(record),
            subject: inputPrimaryID,
            object: outputPrimaryID,
          });
        }
        this.edges[edgeID].addAPI(this.helper._getAPI(record));
        this.edges[edgeID].addSource(this.helper._getSource(record));
        this.edges[edgeID].addPublication(this.helper._getPublication(record));
        Object.keys(record)
          .filter((k) => !(bteAttributes.includes(k) || k.startsWith('$')))
          .map((item) => {
            this.edges[edgeID].addAdditionalAttributes(item, record[item]);
          });
      }
    });
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
  notify() {
    this.subscribers.map((subscriber) => {
      subscriber.update({
        nodes: this.nodes,
        edges: this.edges,
      });
    });
  }
};
