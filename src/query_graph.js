const QNode = require('./query_node');
const QEdge = require('./query_edge');
const QExecEdge = require('./query_execution_edge');
const _ = require('lodash');
const InvalidQueryGraphError = require('./exceptions/invalid_query_graph_error');
const LogEntry = require('./log_entry');
const NewExeEdge = require('./query_execution_edge_2');
const MAX_DEPTH = 3;
const debug = require('debug')('bte:biothings-explorer-trapi:query_graph');
const QNode2 = require('./query_node_2');

module.exports = class QueryGraphHandler {
  constructor(queryGraph) {
    this.queryGraph = queryGraph;
    this.logs = [];
  }

  _validateEmptyNodes(queryGraph) {
    if (Object.keys(queryGraph.nodes).length === 0) {
      throw new InvalidQueryGraphError('Your Query Graph has no nodes defined.');
    }
  }

  _validateEmptyEdges(queryGraph) {
    if (Object.keys(queryGraph.edges).length === 0) {
      throw new InvalidQueryGraphError('Your Query Graph has no edges defined.');
    }
  }

  _validateNodeEdgeCorrespondence(queryGraph) {
    for (let edge_id in queryGraph.edges) {
      if (!(this.queryGraph.edges[edge_id].subject in queryGraph.nodes)) {
        throw new InvalidQueryGraphError(`The subject of edge ${edge_id} is not defined in the query graph.`);
      }
      if (!(this.queryGraph.edges[edge_id].object in queryGraph.nodes)) {
        throw new InvalidQueryGraphError(`The object of edge ${edge_id} is not defined in the query graph.`);
      }
    }
  }

  _validate(queryGraph) {
    this._validateEmptyEdges(queryGraph);
    this._validateEmptyNodes(queryGraph);
    this._validateNodeEdgeCorrespondence(queryGraph);
  }

  /**
   * @private
   */
  _storeNodes() {
    let nodes = {};
    for (let node_id in this.queryGraph.nodes) {
      nodes[node_id] = new QNode(node_id, this.queryGraph.nodes[node_id]);
    }
    this.logs.push(
      new LogEntry('DEBUG', null, `BTE identified ${Object.keys(nodes).length} QNodes from your query graph`).getLog(),
    );
    return nodes;
  }

   /**
   * @private
   */
    _storeNodes_2() {
      let nodes = {};
      for (let node_id in this.queryGraph.nodes) {
        nodes[node_id] = new QNode2(node_id, this.queryGraph.nodes[node_id]);
      }
      this.logs.push(
        new LogEntry('DEBUG', null, `BTE identified ${Object.keys(nodes).length} QNodes from your query graph`).getLog(),
      );
      return nodes;
    }

  /**
   * @private
   */
  _storeEdges() {
    if (this.nodes === undefined) {
      this.nodes = this._storeNodes();
    }
    let edges = {};
    for (let edge_id in this.queryGraph.edges) {
      let edge_info = {
        ...this.queryGraph.edges[edge_id],
        ...{
          subject: this.nodes[this.queryGraph.edges[edge_id].subject],
          object: this.nodes[this.queryGraph.edges[edge_id].object],
        },
      };
      edges[edge_id] = new QEdge(edge_id, edge_info);
    }
    this.logs.push(
      new LogEntry('DEBUG', null, `BTE identified ${Object.keys(edges).length} QEdges from your query graph`).getLog(),
    );
    return edges;
  }

  /**
   * @private
   */
   _storeEdges_2() {
    if (this.nodes === undefined) {
      this.nodes = this._storeNodes_2();
    }
    let edges = {};
    for (let edge_id in this.queryGraph.edges) {
      let edge_info = {
        ...this.queryGraph.edges[edge_id],
        ...{
          subject: this.nodes[this.queryGraph.edges[edge_id].subject],
          object: this.nodes[this.queryGraph.edges[edge_id].object],
        },
      };
      //store in each node ids of edges connected to them
      this.nodes[this.queryGraph.edges[edge_id].subject].updateConnection(edge_id);
      this.nodes[this.queryGraph.edges[edge_id].object].updateConnection(edge_id);

      edges[edge_id] = new QEdge(edge_id, edge_info);
    }
    this.logs.push(
      new LogEntry('DEBUG', null, `BTE identified ${Object.keys(edges).length} QEdges from your query graph`).getLog(),
    );
    return edges;
  }

  /**
   *
   */
  createQueryPaths() {
    this._validate(this.queryGraph);
    const paths = {};
    let current_graph = this._findFirstLevelEdges();
    paths[0] = current_graph.map((item) => item.edge);
    for (let i = 1; i < MAX_DEPTH + 1; i++) {
      current_graph = this._findNextLevelEdges(current_graph);
      if (current_graph.length > 0 && i === MAX_DEPTH) {
        throw new InvalidQueryGraphError(
          `Your Query Graph exceeds the maximum query depth set in bte, which is ${MAX_DEPTH}`,
        );
      }
      if (current_graph.length === 0) {
        break;
      }
      paths[i] = current_graph.map((item) => item.edge);
    }
    this.logs.push(
      new LogEntry(
        'DEBUG',
        null,
        `BTE identified your query graph as a ${Object.keys(paths).length}-depth query graph`,
      ).getLog(),
    );
    debug(`ALL PATHS ${JSON.stringify(paths)}`);
    return paths;
  }

  /**
   *
   */
  calculateEdges() {
    //populate edge and node info
    debug(`(1) Creating edges for manager...`);
    if (this.edges === undefined) {
      this.edges = this._storeEdges_2();
    }
    let edges = {};
    let edge_index = 0;
    //create a smart query edge per edge in query
    for (const edge_id in this.edges) {
      edges[edge_index] = [
        // () ----> ()
        this.edges[edge_id].object.curie ? 
        new NewExeEdge(this.edges[edge_id], true, undefined) :
        new NewExeEdge(this.edges[edge_id], false, undefined)
        // reversed () <---- ()
      ];
      edge_index++;
    }
    return edges;
  }

  /**
   * @private
   */
  _findFirstLevelEdges() {
    if (this.edges === undefined) {
      this.edges = this._storeEdges();
    }
    const result = [];
    for (const edge_id in this.edges) {
      const subjectNode = this.edges[edge_id].subject;
      const objectNode = this.edges[edge_id].object;
      if (subjectNode.hasInput()) {
        result.push({
          current_node: objectNode,
          edge: new QExecEdge(this.edges[edge_id], false, undefined),
          path_source_node: subjectNode,
        });
      }
      if (objectNode.hasInput()) {
        result.push({
          current_node: subjectNode,
          edge: new QExecEdge(this.edges[edge_id], true, undefined),
          path_source_node: objectNode,
        });
      }
    }
    return result;
  }

  /**
   * @private
   */
  _findNextLevelEdges(groups) {
    const result = [];
    for (const edge of Object.values(this.edges)) {
      for (const grp of groups) {
        if (edge.getID() !== grp.edge.getID()) {
          if (edge.subject.getID() === grp.current_node.getID()) {
            result.push({
              current_node: edge.object,
              edge: new QExecEdge(edge, false, grp.edge),
              path_source_node: grp.path_source_node,
            });
          } else if (edge.object.getID() === grp.current_node.getID()) {
            result.push({
              current_node: edge.subject,
              edge: new QExecEdge(edge, true, grp.edge),
              path_source_node: grp.path_source_node,
            });
          }
        }
      }
    }
    return result;
  }
};
