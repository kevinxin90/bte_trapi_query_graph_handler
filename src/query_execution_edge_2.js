const helper = require('./helper');
const debug = require('debug')('bte:biothings-explorer-trapi:UpdatedExeEdge');
const utils = require('./utils');
const reverse = require('./biolink');

//This is an edge class based on QExeEdge with more features
module.exports = class UpdatedExeEdge {
  /**
   *
   * @param {string} id - QEdge ID
   * @param {object} info - QEdge info, e.g. subject, object, predicate
   */
  constructor(qEdge, reverse = false, prev_edge = undefined) {
    this.qEdge = qEdge;
    //nodes that make up this edge
    // this.connecting_nodes = [];
    this.reverse = reverse;
    this.prev_edge = prev_edge;
    //object and subject aliases
    this.input_equivalent_identifiers = {};
    this.output_equivalent_identifiers = {};
    //instances of query_node
    //this.object/subject are instances of QNode
    this.object = qEdge.object;
    this.subject = qEdge.subject;
    //edge has been fully executed
    this.executed = false;
    //run initial checks
    this.logs = [];
    //this edges results
    this.results = [];
    debug(`(2) Created Edge` +
    ` ${JSON.stringify(this.qEdge.getID())} Reverse = ${this.reverse}`)
  }

  chooseLowerEntityValue() {
    //edge has both subject and object entity counts and must choose lower value
    //to use in query.
    debug(`(8) Choosing lower entity count in edge...`);
    if (this.qEdge.object.entity_count && this.qEdge.subject.entity_count) {
      if (this.qEdge.object.entity_count == this.qEdge.subject.entity_count) {
        // //(#) ---> ()
        this.reverse = false;
        delete this.qEdge.object.holdCurie();
        debug(`(8) Sub - Obj were same but chose subject (${this.qEdge.subject.entity_count})`);
      }
      else if (this.qEdge.object.entity_count > this.qEdge.subject.entity_count) {
        //(#) ---> ()
        this.reverse = false;
        //tell node to hold curie in a temp field
        this.qEdge.object.holdCurie();
        debug(`(8) Chose lower entity value in subject (${this.qEdge.subject.entity_count})`);
      } else {
        //() <--- (#)
        this.reverse = true;
        //tell node to hold curie in a temp field
        this.qEdge.subject.holdCurie();
        debug(`(8) Chose lower entity value in object (${this.qEdge.object.entity_count})`);
      }
    }else{
      debug(`(8) Error: Edge must have both object and subject entity values.`);
    }
  }

  extractCuriesFromResponse(res, isReversed) {
    //will give you all curies found by semantic type, each type will have
    //a main ID and all of it's aliases
    debug(`(7) Updating Entities in "${this.qEdge.getID()}"`);
    let typesToInclude = isReversed ?
    this.qEdge.subject.getCategories() :
    this.qEdge.object.getCategories();
    debug(`(7) Collecting Types: "${JSON.stringify(typesToInclude)}"`);
    let all = {};
    res.forEach((result) => {

      result.$input.obj.forEach((o) => {
        //create semantic type if not included
        let type = o._leafSemanticType;
        if (typesToInclude.includes(type) || 
          typesToInclude.includes('NamedThing') ||
          typesToInclude.toString().includes(type)) {
          if (!Object.hasOwnProperty.call(all, type)) {
            all[type] = {};
          }
          //get original and aliases
          let original = result.$input.original;
          //#1 prefer equivalent ids
          if (Object.hasOwnProperty.call(o, '_dbIDs')) {
            let original_aliases = new Set();
            for (const prefix in o._dbIDs) {
              //check if array
              if (Array.isArray(o._dbIDs[prefix])) {
                o._dbIDs[prefix].forEach((single_alias) => {
                  if (single_alias.includes(':')) {
                    //value already has prefix
                    original_aliases.add(single_alias);
                  }else{
                    //concat with prefix
                    original_aliases.add(prefix + ':' + single_alias);
                  }
                });
              }else{
                if (o._dbIDs[prefix].includes(':')) {
                  //value already has prefix
                  original_aliases.add(o._dbIDs[prefix]);
                }else{
                  //concat with prefix
                  original_aliases.add(prefix + ':' + o._dbIDs[prefix]);
                }
              }
            }
            original_aliases = [...original_aliases];
            //check and add only unique
            let was_found = false;
            original_aliases.forEach((alias) => {
              if (Object.hasOwnProperty.call(all[type], alias)) {
                was_found = true;
              }
            });
            if (!was_found) {
              all[type][original] = original_aliases;
            }
          }
          //else #2 check curie
          else if(Object.hasOwnProperty.call(o, 'curie')) {
            if (Array.isArray( o.curie)) {
              all[type][original] = o.curie;
            }else{
              all[type][original] = [o.curie];
            }
          }
          //#3 last resort check original
          else{
            all[type][original] = [original];
          }
        }
      });

      result.$output.obj.forEach((o) => {
        //create semantic type if not included
        let type = o._leafSemanticType;
        if (typesToInclude.includes(type) || 
          typesToInclude.includes('NamedThing') ||
          typesToInclude.toString().includes(type))  {
          if (!Object.hasOwnProperty.call(all, type)) {
            all[type] = {};
          }
          //get original and aliases
          let original = result.$output.original;
          
          //#1 prefer equivalent ids
          if (Object.hasOwnProperty.call(o, '_dbIDs')){
            let original_aliases = new Set();
            for (const prefix in o._dbIDs) {
              //check if array
              if (Array.isArray(o._dbIDs[prefix])) {
                o._dbIDs[prefix].forEach((single_alias) => {
                  if (single_alias.includes(':')) {
                    //value already has prefix
                    original_aliases.add(single_alias);
                  }else{
                    //concat with prefix
                    original_aliases.add(prefix + ':' + single_alias);
                  }
                });
              }else{
                if (o._dbIDs[prefix].includes(':')) {
                  //value already has prefix
                  original_aliases.add(o._dbIDs[prefix]);
                }else{
                  //concat with prefix
                  original_aliases.add(prefix + ':' + o._dbIDs[prefix]);
                }
              }
            }
            original_aliases = [...original_aliases];
            //check and add only unique
            let was_found = false;
            original_aliases.forEach((alias) => {
              if (Object.hasOwnProperty.call(all[type], alias)) {
                was_found = true;
              }
            });
            if (!was_found) {
              all[type][original] = original_aliases;
            }
          }
          //else #2 check curie
          else if(Object.hasOwnProperty.call(o, 'curie')) {
            if (Array.isArray( o.curie)) {
              all[type][original] = o.curie;
            }else{
              all[type][original] = [o.curie];
            }
          }
          //#3 last resort check original
          else{
            all[type][original] = [original];
          }
        }
      });
      
    });
    // {Gene:{'id': ['alias']}}
    debug(`Collected entity ids in results: ${JSON.stringify(Object.keys(all))}`);
    return all;
  }

  _combineCuries(curies) {
    //combine all curies in case there are
    //multiple categories in this node since
    //they are separated by type
    let combined  = {};
    for (const type in curies) {
      for (const original in curies[type]) {
        combined[original] = curies[type][original];
      }
    }
    return combined;
  }

  updateNodesCuries(res) {
    //update node queried (1) ---> (update)
    let curies_by_semantic_type = this.extractCuriesFromResponse(res, this.reverse);
    let combined_curies = this._combineCuries(curies_by_semantic_type);
    this.reverse ?
    this.qEdge.subject.updateCuries(combined_curies) :
    this.qEdge.object.updateCuries(combined_curies);
    //update node used as input (1 [update]) ---> ()
    let curies_by_semantic_type_2 = this.extractCuriesFromResponse(res, !this.reverse);
    let combined_curies_2 = this._combineCuries(curies_by_semantic_type_2);
    !this.reverse ?
    this.qEdge.subject.updateCuries(combined_curies_2) :
    this.qEdge.object.updateCuries(combined_curies_2);
  }

  storeResults(res) {
    debug(`(6) Storing results...`);
    //store unfiltered results from edge query in edge
    this.results = res;
    debug(`(7) Updating nodes based on edge results...`);
    this.updateNodesCuries(res);
  }

  getID() {
    return this.qEdge.getID();
  }

  getHashedEdgeRepresentation() {
    const toBeHashed =
      this.getSubject().getCategories() + this.getPredicate() + this.getObject().getCategories() + this.getInputCurie();
    return new helper()._generateHash(toBeHashed);
  }

  expandPredicates(predicates) {
    const reducer = (acc, cur) => [...acc, ...reverse.getDescendantPredicates(cur)];
    return Array.from(new Set(predicates.reduce(reducer, [])));
  }

  getPredicate() {
    if (this.predicate === undefined) {
      return undefined;
    }
    const predicates = utils.toArray(this.predicate).map((item) => utils.removeBioLinkPrefix(item));
    const expandedPredicates = this.expandPredicates(predicates);
    debug(`Expanded edges: ${expandedPredicates}`);
    return expandedPredicates
      .map((predicate) => {
        return this.isReversed() === true ? reverse.reverse(predicate) : predicate;
      })
      .filter((item) => !(typeof item === 'undefined'));
  }

  getSubject() {
    if (this.reverse) {
      return this.qEdge.object;
    }
    return this.qEdge.subject;
  }

  getObject() {
    if (this.reverse) {
      return this.qEdge.subject;
    }
    return this.qEdge.object;
  }

  isReversed() {
    return this.reverse;
  }

  getInputCurie() {
    let curie = this.qEdge.subject.getCurie() || this.qEdge.object.getCurie();
    if (Array.isArray(curie)) {
      return curie;
    }
    return [curie];
  }

  getInputNode() {
    return this.reverse ? this.qEdge.object : this.qEdge.subject;
  }

  getOutputNode() {
    return this.reverse ? this.qEdge.subject : this.qEdge.object;
  }

  hasInputResolved() {
    return !(Object.keys(this.input_equivalent_identifiers).length === 0);
  }

  hasInput() {
    if (this.reverse) {
      return this.qEdge.object.hasInput();
    }
    return this.qEdge.subject.hasInput();
  }
};

