const _ = require('lodash');
const LogEntry = require('./log_entry');
const debug = require('debug')('bte:biothings-explorer-trapi:edge-manager');

module.exports = class EdgeManager {
    constructor(edges) {
        // flatten list of all edges available
        this.edges = _.flatten(Object.values(edges));
        this.logs = [];
        this.results = [];
        //organized by edge with refs to connected edges
        this.organized_results = {};
        this.init();
    }

    getResults() {
        debug(`(13) Edge Manager reporting combined results...`);
        return this.results;
    }

    getOrganizedResults() {
        debug(`(13) Edge Manager reporting organized results...`);
        return this.organized_results;
    }

    init() {
        debug(`(3) Edge manager is managing ${this.edges.length} edges.`);
        this.logs.push(
            new LogEntry(
                'DEBUG',
                null,
                `Edge manager is managing ${this.edges.length} edges.`,
            ).getLog(),
        );
    }

    getNext() {
        //returns next edge with lowest entity count on
        //either object or subject OR no count last
        
        // available not yet executed
        let available_edges = this.edges
        .filter(edge => !edge.executed);
        //safeguard for making sure there's available
        //edges when calling getNext
        if (available_edges.length == 0) {
            debug(`(5) Error: ${available_edges} available edges found.`);
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `Edge manager cannot get next edge, ` +
                    `(${available_edges} )available edges found.`,
                ).getLog(),
            );
        }
        //begin search
        let next;
        let lowest_entity_count;
        let current_obj_lowest = 0;
        let current_sub_lowest = 0;
        available_edges.forEach((edge) => {
            if (
                edge && 
                edge.object.entity_count
                ) {
                current_obj_lowest = edge.object.entity_count;
                if (!lowest_entity_count) {
                    //set current lowest if none
                    lowest_entity_count = current_obj_lowest;
                }
                if (current_obj_lowest <= lowest_entity_count) {
                    //lowest is now object count
                    next = edge;
                }
            }
            if (
                edge && 
                edge.subject.entity_count &&
                edge.subject.entity_count > 0
                ) {
                current_sub_lowest = edge.subject.entity_count;
                if (!lowest_entity_count) {
                    //set current lowest if none
                    lowest_entity_count = current_sub_lowest;
                }
                if (current_sub_lowest <= lowest_entity_count) {
                    //lowest is now subject count
                    next = edge;
                }
            }
        });
        if (!next) {
            //if no edge with count found pick the first empty
            //edge available
            let all_empty = available_edges
            .filter((edge) => !edge.object.entity_count && !edge.subject.entity_count);
            if (all_empty.length == 0) {
                debug(`(5) Error: No available edges found.`);
                this.logs.push(
                    new LogEntry(
                        'DEBUG',
                        null,
                        `Cannot get next edge, No available edges found.`,
                    ).getLog(),
                );
            }
            debug(`(5) Sending next edge '${all_empty[0].getID()}' with NO entity count.`);
            return this.preSendOffCheck(all_empty[0]);
        }
        debug(`(5) Sending next edge '${next.getID()}' ` +
        `WITH entity count...(${next.subject.entity_count || next.object.entity_count})`);
        return this.preSendOffCheck(next);
    }

    logEntityCounts() {
        this.edges.forEach((edge) => {
            debug(`'${edge.getID()}'` +
            ` : (${edge.subject.entity_count || 0}) ` +
            `${edge.reverse ? '<--' : '-->'}` +
            ` (${edge.object.entity_count || 0})`);
        });
    }

    preSendOffCheck(next) {
        if (next.object.entity_count && next.subject.entity_count) {
            //if at the time of being queried the edge has both
            //obj and sub entity counts
            //chose obj/suj lower entity count for query
            next.chooseLowerEntityValue();
            this.logs.push(
                new LogEntry('DEBUG', 
                null, 
                `Next edge will pick lower entity value to use for query.`).getLog(),
            );
        }
        this.logs.push(
            new LogEntry('DEBUG', 
            null, 
            `Edge manager is sending next edge '${next.getID()}' for execution.`).getLog(),
        );
        this.logEntityCounts();
        return next;
    }

    getEdgesNotExecuted() {
        //simply returns a number of edges not marked as executed
        let found = this.edges.filter(edge => !edge.executed);
        let not_executed = found.length;
        if(not_executed) debug(`(4) Edges not yet executed = ${not_executed}`);
        return not_executed;
    }

    _filterEdgeResults(edge) {
        let keep = [];
        let results = edge.results;
        let sub_curies = edge.subject.curie;
        let obj_curies = edge.object.curie;
        debug(`'${edge.getID()}' Reversed[${edge.reverse}] (${JSON.stringify(sub_curies.length || 0)})` +
        `--(${JSON.stringify(obj_curies.length || 0)}) entities / (${results.length}) results.`);
        // debug(`IDS SUB ${JSON.stringify(sub_curies)}`)
        // debug(`IDS OBJ ${JSON.stringify(obj_curies)}`)
        let object_node_ids = edge.reverse ? sub_curies : obj_curies;
        let subject_node_ids = edge.reverse ? obj_curies : sub_curies;

        results.forEach((res) => {
            //check sub curies against $input ids
            let ids = new Set();
            let outputMatch = false;
            let inputMatch = false;
            res.$input.obj.forEach((o) => {
                //compare result I/O ids against edge node ids
                //#1 check equivalent ids
                if (Object.hasOwnProperty.call(o, '_dbIDs')) {
                    for (const prefix in o._dbIDs) {
                        //check if array
                        if (Array.isArray(o._dbIDs[prefix])) {
                            o._dbIDs[prefix].forEach((single_alias) => {
                            if (single_alias.includes(':')) {
                                //value already has prefix
                                ids.add(single_alias);
                            }else{
                                //concat with prefix
                                ids.add(prefix + ':' + single_alias);
                            }
                            });
                        }else{
                            if (o._dbIDs[prefix].includes(':')) {
                                //value already has prefix
                                ids.add(o._dbIDs[prefix]);
                            }else{
                                //concat with prefix
                                ids.add(prefix + ':' + o._dbIDs[prefix]);
                            }
                        }
                    }
                }
                //else #2 check curie
                else if(Object.hasOwnProperty.call(o, 'curie')) {
                    ids.add(o.curie);
                }
                //#3 last resort check original
                else{
                    ids.add(res.$input.original);
                }
                //check ids
                inputMatch = _.intersection([...ids], subject_node_ids).length;
            });
            //check obj curies against $output ids
            let o_ids = new Set();
            res.$output.obj.forEach((o) => {
                //#1 check equivalent ids
                if (Object.hasOwnProperty.call(o, '_dbIDs')) {
                    for (const prefix in o._dbIDs) {
                        //check if array
                        if (Array.isArray(o._dbIDs[prefix])) {
                            o._dbIDs[prefix].forEach((single_alias) => {
                            if (single_alias.includes(':')) {
                                //value already has prefix
                                o_ids.add(single_alias);
                            }else{
                                //concat with prefix
                                o_ids.add(prefix + ':' + single_alias);
                            }
                            });
                        }else{
                            if (o._dbIDs[prefix].includes(':')) {
                                //value already has prefix
                                o_ids.add(o._dbIDs[prefix]);
                            }else{
                                //concat with prefix
                                o_ids.add(prefix + ':' + o._dbIDs[prefix]);
                            }
                        }
                    }
                }
                //else #2 check curie
                else if(Object.hasOwnProperty.call(o, 'curie')) {
                    o_ids.add(o.curie);
                }
                //#3 last resort check original
                else{
                    o_ids.add(res.$output.original);
                }
                //check ids
                outputMatch = _.intersection([...o_ids], object_node_ids).length;
            });
            //if both ends match then keep result
            if (inputMatch && outputMatch) {
                keep.push(res);
            }
        });
        debug(`'${edge.getID()}' dropped (${results.length - keep.length}) results.`);
        this.logs.push(
            new LogEntry(
                'DEBUG',
                null,
                `'${edge.getID()}' kept (${keep.length}) / dropped (${results.length - keep.length}) results.`
            ).getLog(),
        );
        return keep;
    }

    gatherResults() {
        //go through edges filter and collect all results
        let results = [];
        let brokenChain = false;
        let brokenEdges = [];
        debug(`(11) Collecting results...`);
        //First: go through edges and filter that each edge is holding
        this.edges.forEach((edge) => {
            let filtered_res = this._filterEdgeResults(edge);
            if (filtered_res.length == 0) {
                this.logs.push(
                    new LogEntry(
                        'DEBUG',
                        null,
                        `Warning: Edge '${edge.getID()}' resulted in (0) results.`
                    ).getLog(),
                );
                brokenChain = true;
                brokenEdges.push(edge.getID());
            }
            this.logs = [...this.logs, ...edge.logs];
            //store filtered results
            edge.results = filtered_res;
            //collect results
            results = results.concat(filtered_res);
            debug(`(11) '${edge.getID()}' keeps (${filtered_res.length}) results!`);
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `'${edge.getID()}' keeps (${filtered_res.length}) results!`
                ).getLog(),
            );
            debug(`----------`);
        });
        if (brokenChain) {
            results = [];
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `Edges ${JSON.stringify(brokenEdges)} ` +
                    `resulted in (0) results. No complete paths can be formed.`
                ).getLog(),
            );
            debug(`(12) Edges ${JSON.stringify(brokenEdges)} ` +
            `resulted in (0) results. No complete paths can be formed.`);
        }
        //Second: collected results
        this.results = results;
        debug(`(12) Collected (${this.results.length}) results!`);
        this.logs.push(
            new LogEntry(
                'DEBUG',
                null,
                `Edge manager collected (${this.results.length}) results!`
            ).getLog(),
        );
    }

    collectResults() {
        //go through edges and collect all results only
        let results = [];
        let brokenChain = false;
        let brokenEdges = [];
        debug(`(11) Collecting results...`);
        //First: go through edges and filter that each edge is holding
        this.edges.forEach((edge) => {
            let filtered_res = edge.results;
            if (filtered_res.length == 0) {
                this.logs.push(
                    new LogEntry(
                        'DEBUG',
                        null,
                        `Warning: Edge '${edge.getID()}' resulted in (0) results.`
                    ).getLog(),
                );
                brokenChain = true;
                brokenEdges.push(edge.getID());
            }
            this.logs = [...this.logs, ...edge.logs];
            //collect results
            results = results.concat(filtered_res);
            debug(`(11) '${edge.getID()}' keeps (${filtered_res.length}) results!`);
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `'${edge.getID()}' keeps (${filtered_res.length}) results!`
                ).getLog(),
            );
            debug(`----------`);
        });
        if (brokenChain) {
            results = [];
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `Edges ${JSON.stringify(brokenEdges)} ` +
                    `resulted in (0) results. No complete paths can be formed.`
                ).getLog(),
            );
            debug(`(12) Edges ${JSON.stringify(brokenEdges)} ` +
            `resulted in (0) results. No complete paths can be formed.`);
        }
        //Second: collected results
        this.results = results;
        debug(`(12) Collected (${this.results.length}) results!`);
        this.logs.push(
            new LogEntry(
                'DEBUG',
                null,
                `Edge manager collected (${this.results.length}) results!`
            ).getLog(),
        );
    }

    collectOrganizedResults() {
        //go through edges and collect results organized by edge
        let results = {};
        let brokenChain = false;
        let brokenEdges = [];
        debug(`(11) Collecting results...`);
        //First: go through edges and filter that each edge is holding
        this.edges.forEach((edge) => {
            let edge_ID = edge.getID();
            let filtered_res = edge.results;
            if (filtered_res.length == 0) {
                this.logs.push(
                    new LogEntry(
                        'DEBUG',
                        null,
                        `Warning: Edge '${edge_ID}' resulted in (0) results.`
                    ).getLog(),
                );
                brokenChain = true;
                brokenEdges.push(edge_ID);
            }
            this.logs = [...this.logs, ...edge.logs];
            //collect results
            let connections = edge.qEdge.subject.getConnections().concat(edge.qEdge.object.getConnections());
            connections = connections.filter(id => id !== edge_ID);
            connections = new Set(connections);
            results[edge_ID] = {
                records: filtered_res,
                connected_to: [...connections],
            }
            debug(`(11) '${edge_ID}' keeps (${filtered_res.length}) results!`);
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `'${edge_ID}' keeps (${filtered_res.length}) results!`
                ).getLog(),
            );
            debug(`----------`);
        });
        if (brokenChain) {
            results = {};
            this.logs.push(
                new LogEntry(
                    'DEBUG',
                    null,
                    `Edges ${JSON.stringify(brokenEdges)} ` +
                    `resulted in (0) results. No complete paths can be formed.`
                ).getLog(),
            );
            debug(`(12) Edges ${JSON.stringify(brokenEdges)} ` +
            `resulted in (0) results. No complete paths can be formed.`);
        }
        //Second: collected results
        this.organized_results = results;
        debug(`(12) Collected results for: (${JSON.stringify(Object.keys(this.organized_results))})!`);
        this.logs.push(
            new LogEntry(
                'DEBUG',
                null,
                `Edge manager collected (${this.results.length}) results!`
            ).getLog(),
        );
    }

    updateEdgeResults(current_edge) {
        let filtered_res = this._filterEdgeResults(current_edge);
        //this triggers node update
        current_edge.storeResults(filtered_res);
    }

    updateNeighborsEdgeResults(current_edge) {
        debug(`Updating neighbors...`);
        let not_this_edge = current_edge.getID();
        //get neighbors of this edges subject that are not this edge
        let left_connections = current_edge.qEdge.subject.getConnections();
        left_connections = left_connections.filter((edge_id) => edge_id !== not_this_edge);
        //get neighbors of this edges object that are not this edge
        let right_connections = current_edge.qEdge.object.getConnections();
        right_connections = right_connections.filter((edge_id) => edge_id !== not_this_edge);
        debug(`(${left_connections})<--edge neighbors-->(${right_connections})`);
        if (left_connections.length) {
            //find edge by id
            left_connections.forEach((neighbor_id) => {
                let edge = this.edges.find((edge) => edge.getID() == neighbor_id);
                if (edge && edge.results.length) {
                    debug(`Updating "${edge.getID()}" neighbor edge of ${not_this_edge}`);
                    debug(`Updating neighbor (X)<----()`);
                    this.updateEdgeResults(edge);
                }
            });
        }

        if (right_connections.length) {
            //find edge by id
            right_connections.forEach((neighbor_id) => {
                let edge = this.edges.find((edge) => edge.getID() == neighbor_id);
                if (edge && edge.results.length) {
                    debug(`Updating "${edge.getID()}" neighbor edge of ${not_this_edge}`);
                    debug(`Updating neighbor ()---->(X)`);
                    this.updateEdgeResults(edge);
                }
            });
        }
    }

    updateAllOtherEdges(current_edge) {
        debug(`Updating all other edges...`);
        let not_this_edge = current_edge.getID();
        this.edges.forEach((edge) => {
            if (edge.getID() !== not_this_edge && edge.results.length) {
                debug(`Updating "${edge.getID()}"...`);
                this.updateEdgeResults(edge);
                this.updateEdgeResults(current_edge);
            }
        });
    }
};
