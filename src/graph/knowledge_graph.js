const GraphHelper = require('../helper');
const debug = require('debug')('bte:biothings-explorer-trapi:KnowledgeGraph');
const helper = new GraphHelper();

module.exports = class KnowledgeGraph {
  constructor() {
    this.nodes = {};
    this.edges = {};
    this.kg = {
      nodes: this.nodes,
      edges: this.edges,
    };
  }

  getNodes() {
    return this.nodes;
  }

  getEdges() {
    return this.edges;
  }

  _createNode(kgNode) {
    const res = {
      categories: ['biolink:' + kgNode._semanticType],
      name: kgNode._label,
      attributes: [
        {
          attribute_type_id: 'biolink:xref',
          value: kgNode._curies,
        },
        {
          attribute_type_id: 'biolink:synonym',
          value: kgNode._names,
        },
        {
          attribute_type_id: 'num_source_nodes',
          value: kgNode._sourceNodes.size,
          value_type_id: 'bts:num_source_nodes',
        },
        {
          attribute_type_id: 'num_target_nodes',
          value: kgNode._targetNodes.size,
          value_type_id: 'bts:num_target_nodes',
        },
        {
          attribute_type_id: 'source_qg_nodes',
          value: Array.from(kgNode._sourceQGNodes),
          value_type_id: 'bts:source_qg_nodes',
        },
        {
          attribute_type_id: 'target_qg_nodes',
          value: Array.from(kgNode._targetQGNodes),
          value_type_id: 'bts:target_qg_nodes',
        },
      ],
    };
    for (const key in kgNode._nodeAttributes) {
      res.attributes.push({
        attribute_type_id: key,
        value: kgNode._nodeAttributes[key],
        value_type_id: 'bts:' + key,
      });
    }
    return res;
  }

  _createAttributes(kgEdge) {
    let attributes = [
      {
        attribute_type_id: 'biolink:primary_knowledge_source',
        value: Array.from(kgEdge.sources),
        value_type_id: 'biolink:InformationResource',
      },
      {
        attribute_type_id: 'biolink:aggregator_knowledge_source',
        value: Array.from(kgEdge.apis),
        value_type_id: 'biolink:InformationResource',
      },
      {
        attribute_type_id: 'publications',
        value: Array.from(kgEdge.publications),
        value_type_id: 'biolink:publication',
      },
    ];

    if (kgEdge.attributes.attributes) {
      attributes = [
        {
          "attribute_type_id": "biolink:aggregator_knowledge_source",
          "value": "infores:translator-biothings-explorer",
          "value_type_id": "biolink:InformationResource"
        }, 
        ...kgEdge.attributes.attributes
      ];
    } else {
      for (const key in kgEdge.attributes) {
        attributes.push({
          attribute_type_id: key,
          value: kgEdge.attributes[key],
          value_type_id: 'bts:' + key,
        });
      }
    }
    return attributes;
  }

  _createEdge(kgEdge) {
    return {
      predicate: kgEdge.predicate,
      subject: kgEdge.subject,
      object: kgEdge.object,
      attributes: this._createAttributes(kgEdge),
    };
  }

  update(bteGraph) {
    Object.keys(bteGraph.nodes).map((node) => {
      this.nodes[bteGraph.nodes[node]._primaryID] = this._createNode(bteGraph.nodes[node]);
    });
    Object.keys(bteGraph.edges).map((edge) => {
      this.edges[edge] = this._createEdge(bteGraph.edges[edge]);
    });
    this.kg = {
      nodes: this.nodes,
      edges: this.edges,
    };
  }
};
