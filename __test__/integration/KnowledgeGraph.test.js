const QNode = require("../../src/query_node");
const QEdge = require("../../src/query_edge");
const KnowledgeGraph = require("../../src/graph/knowledge_graph");

describe("Testing KnowledgeGraph Module", () => {
    const nodeInput = {
        "id": "PUBCHEM.COMPOUND:2662-n0",
        "_primaryID": "PUBCHEM.COMPOUND:2662",
        "_qgID": "n0",
        "_curies": [
            "PUBCHEM.COMPOUND:2662",
            "CHEMBL.COMPOUND:CHEMBL118",
            "UNII:JCX84Q7J1L",
            "CHEBI:41423",
            "DRUGBANK:DB00482",
            "MESH:C105934",
            "MESH:D000068579",
            "CAS:169590-42-5",
            "CAS:184007-95-2",
            "CAS:194044-54-7",
            "DrugCentral:568",
            "GTOPDB:2892",
            "HMDB:HMDB0005014",
            "KEGG.COMPOUND:C07589",
            "INCHIKEY:RZEKVGVHFLEQIL-UHFFFAOYSA-N"
        ],
        "_names": [
            "Celecoxib",
            "CELECOXIB",
            "celecoxib",
            "[OBSOLETE] celecoxib"
        ],
        "_semanticType": "SmallMolecule",
        "_nodeAttributes": {},
        "_label": "Celecoxib",
        "_sourceNodes": {},
        "_targetNodes": {},
        "_sourceQGNodes": {},
        "_targetQGNodes": {}
    }
    const trapiEdgeInput = {
        id: 'PUBCHEM.COMPOUND:2662-biolink:activity_decreased_by-NCBIGene:771',
        predicate: 'biolink:activity_decreased_by',
        subject: 'PUBCHEM.COMPOUND:2662',
        object: 'NCBIGene:771',
        apis: {},
        sources: {},
        publications: {},
        attributes: {
            attributes: [
                {
                    attribute_type_id: 'biolink:Attribute',
                    value: 'Ki',
                    value_type_id: 'EDAM:data_0006',
                    original_attribute_name: 'affinity_parameter',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
                {
                    attribute_type_id: 'biolink:knowledge_source',
                    value: ['PHAROS_1_norm_edges.jsonl'],
                    value_type_id: 'EDAM:data_0006',
                    original_attribute_name: 'knowledge_source',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
                {
                    attribute_type_id: 'biolink:aggregator_knowledge_source',
                    value: ['infores:pharos'],
                    value_type_id: 'biolink:InformationResource',
                    original_attribute_name: 'biolink:aggregator_knowledge_source',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
                {
                    attribute_type_id: 'biolink:Attribute',
                    value: 7.75,
                    value_type_id: 'EDAM:data_0006',
                    original_attribute_name: 'affinity',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
                {
                    attribute_type_id: 'biolink:publications',
                    value: [
                        'PMID:20605094',
                        'PMID:21852133',
                        'PMID:16290146',
                        'PMID:23965175',
                        'PMID:23965175',
                        'PMID:24513184',
                        'PMID:25766630',
                        'PMID:23067387',
                    ],
                    value_type_id: 'EDAM:data_0006',
                    original_attribute_name: 'publications',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
                {
                    attribute_type_id: 'biolink:relation',
                    value: 'GAMMA:ki',
                    value_type_id: 'EDAM:data_0006',
                    original_attribute_name: 'relation',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
                {
                    attribute_type_id: 'biolink:aggregator_knowledge_source',
                    value: 'infores:automat.pharos',
                    value_type_id: 'biolink:InformationResource',
                    original_attribute_name: 'biolink:aggregator_knowledge_source',
                    value_url: null,
                    attribute_source: null,
                    description: null,
                },
            ],
        },
    };
    
    describe("Testing _createNode function", () => {
        test("test creating node", () => {
            const kg = new KnowledgeGraph();
            const res = kg._createNode(nodeInput);
            expect(res).toHaveProperty("name", "Celecoxib");
            expect(res).toHaveProperty('categories')
            expect(res.categories[0]).toBe('biolink:SmallMolecule');
            expect(res).toHaveProperty('attributes');
        })
    })

    describe("Testing _createAttributes function", () => {
        test("test edge attributes", () => {
            const kg = new KnowledgeGraph();
            const res = kg._createAttributes(trapiEdgeInput);
            expect(res.length).toBeGreaterThan(0);
            for (let res_obj of res) {
                expect(res_obj).toHaveProperty('attribute_type_id');
                expect(res_obj).toHaveProperty('value');
                expect(res_obj).toHaveProperty('value_type_id');
            }
        })
    })

    describe("Testing _createEdge function", () => {
        test("test creating edge", () => {
            const kg = new KnowledgeGraph();
            const res = kg._createEdge(trapiEdgeInput);
            expect(res).toHaveProperty("predicate", "biolink:activity_decreased_by");
            expect(res).toHaveProperty("subject", "PUBCHEM.COMPOUND:2662");
            expect(res).toHaveProperty("object", "NCBIGene:771");
            expect(res).toHaveProperty("attributes");
            for (let res_obj of res.attributes) {
                expect(res_obj).toHaveProperty('attribute_type_id');
                expect(res_obj).toHaveProperty('value');
                expect(res_obj).toHaveProperty('value_type_id');
            }
        })
    })

})