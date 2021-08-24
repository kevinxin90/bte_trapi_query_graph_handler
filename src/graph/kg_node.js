module.exports = class KGNode {
  constructor(id, info) {
    this.id = id;
    this._primaryID = info.primaryID;
    this._qgID = info.qgID;
    this._curies = info.equivalentIDs;
    this._names = info.names;
    this._semanticType = info.category;
    this._nodeAttributes = info.nodeAttributes;
    this._label = info.label;
    this._sourceNodes = new Set();
    this._targetNodes = new Set();
    this._sourceQGNodes = new Set();
    this._targetQGNodes = new Set();
  }

  addSourceNode(kgNode) {
    this._sourceNodes.add(kgNode);
  }

  addTargetNode(kgNode) {
    this._targetNodes.add(kgNode);
  }

  addSourceQGNode(qgNode) {
    this._sourceQGNodes.add(qgNode);
  }

  addTargetQGNode(qgNode) {
    this._targetQGNodes.add(qgNode);
  }
};
