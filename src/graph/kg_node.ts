import { TrapiAttribute } from '@biothings-explorer/types';

export interface KGNodeInfo {
  label: string;
  nodeAttributes?: TrapiAttribute;
  semanticType: string[];
  names: string[];
  curies: string[];
  primaryCurie: string;
  qNodeID: string;
  originalCurie?: string;
}

export default class KGNode {
  id: string;
  primaryCurie: string;
  qNodeID: string;
  originalCurie: string;
  curies: string[];
  names: string[];
  semanticType: string[];
  nodeAttributes: TrapiAttribute;
  label: string;
  sourceNodes: Set<string>;
  targetNodes: Set<string>;
  sourceQNodeIDs: Set<string>;
  targetQNodeIDs: Set<string>;
  constructor(id: string, info: KGNodeInfo) {
    this.id = id;
    this.primaryCurie = info.primaryCurie;
    this.qNodeID = info.qNodeID;
    this.curies = info.curies;
    this.names = info.names;
    this.semanticType = info.semanticType;
    this.nodeAttributes = info.nodeAttributes;
    this.label = info.label;
    this.sourceNodes = new Set();
    this.targetNodes = new Set();
    this.sourceQNodeIDs = new Set();
    this.targetQNodeIDs = new Set();

    // store original curie to output `query_id bte#815`
    this.originalCurie = info.originalCurie;
  }

  addSourceNode(kgNodeID: string): void {
    this.sourceNodes.add(kgNodeID);
  }

  addTargetNode(kgNodeID: string): void {
    this.targetNodes.add(kgNodeID);
  }

  addSourceQNodeID(qNodeID: string): void {
    this.sourceQNodeIDs.add(qNodeID);
  }

  addTargetQNodeID(qNodeID: string): void {
    this.targetQNodeIDs.add(qNodeID);
  }
}
