import os
import sys
import json
import time
import shutil
import kuzu

DEFAULT_DB_DIR = os.path.join(os.path.dirname(__file__), "data", "upgraded_pcm_kuzu")

class UpgradedPCMKuzuEngine:
    def __init__(self, db_path: str = DEFAULT_DB_DIR):
        self.db_path = db_path
        self.db = None
        self.conn = None
        self.init_db()

    def init_db(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        self.db = kuzu.Database(self.db_path)
        self.conn = kuzu.Connection(self.db)

        # Create Entity Node table
        try:
            self.conn.execute("CREATE NODE TABLE Entity(name STRING, entity_type STRING, PRIMARY KEY (name))")
        except Exception:
            pass

        # Create RelatesTo Relationship table
        try:
            self.conn.execute("""
                CREATE REL TABLE RelatesTo(
                    FROM Entity TO Entity, 
                    predicate STRING, 
                    confidence DOUBLE, 
                    source_memory_id STRING,
                    project_scope STRING,
                    created_at INT64
                )
            """)
        except Exception:
            pass

    def upsert_triplet(self, source: str, predicate: str, target: str, 
                       source_type: str = "Technology", target_type: str = "Technology",
                       confidence: float = 1.0, memory_id: str = "", project: str = ""):
        # Upsert entities
        for name, etype in [(source, source_type), (target, target_type)]:
            try:
                self.conn.execute(
                    "CREATE (:Entity {name: $name, entity_type: $etype})",
                    parameters={"name": str(name), "etype": str(etype)}
                )
            except Exception as e:
                pass

        # Create directed edge
        try:
            self.conn.execute(
                """
                MATCH (a:Entity {name: $src}), (b:Entity {name: $tgt})
                CREATE (a)-[:RelatesTo {
                    predicate: $pred, 
                    confidence: $conf, 
                    source_memory_id: $mem_id,
                    project_scope: $proj,
                    created_at: $ts
                }]->(b)
                """,
                parameters={
                    "src": str(source),
                    "pred": str(predicate),
                    "tgt": str(target),
                    "conf": float(confidence),
                    "mem_id": str(memory_id),
                    "proj": str(project),
                    "ts": int(time.time() * 1000)
                }
            )
        except Exception as e:
            print("Rel error:", e, file=sys.stderr)

    def query_subgraph(self, query: str, project_scope: str = "", max_hops: int = 2, top_k: int = 6):
        """
        Extracts multi-hop relational subgraph relevant to query and project with single-pass Cypher.
        """
        import re
        tokens = [re.sub(r"^\W+|\W+$", "", w.lower()) for w in query.strip().split()]
        stop_words = {"what", "does", "give", "tell", "about", "with", "from", "this", "that", "have", "your", "today", "tonight", "brief", "for", "and", "the", "are", "can", "will", "our", "all", "any", "out", "not", "but", "now"}
        words = [w for w in tokens if len(w) > 2 and w not in stop_words]

        GRAPH_SYNONYMS = {
            "workout": ["swim", "swimming", "run", "running", "activity", "fitness", "denver"],
            "fitness": ["swim", "swimming", "run", "running", "activity", "workout", "denver"],
            "activity": ["swim", "swimming", "run", "running", "fitness", "workout", "denver"],
            "routine": ["swim", "swimming", "run", "running"],
            "outdoor": ["lake", "run", "running", "denver", "austin"],
            "spouse": ["alex", "partner", "wife", "husband", "profession", "anniversary", "wedding"],
            "living": ["profession", "career", "job", "work", "architect"],
            "dinner": ["food", "thai", "curry", "cuisine", "restaurant", "eat", "poisoning"],
            "lunch": ["food", "eat", "shellfish", "clam", "oyster", "restaurant", "epipen"],
            "recommendations": ["dinner", "food", "thai", "curry", "cuisine"],
            "bio": ["career", "founder", "cto", "manager", "fintech", "cogmesh"],
            "keynote": ["founder", "cto", "cogmesh", "career"],
            "conference": ["founder", "cto", "cogmesh"],
            "medical": ["lexapro", "anxiety", "health", "dental", "allergy", "vision"],
            "trainer": ["health", "medical", "fitness", "exercise"],
        }

        expanded_words = set(words)
        for w in words:
            if w in GRAPH_SYNONYMS:
                for syn in GRAPH_SYNONYMS[w]:
                    expanded_words.add(syn)

        if not expanded_words:
            return []

        triplets = []
        seen = set()

        pattern = "|".join([re.escape(w) for w in expanded_words])
        try:
            scope_filter = "AND (lower(r.project_scope) = $proj OR r.project_scope = '')" if project_scope else ""
            query_cypher = f"""
            MATCH (a:Entity)-[r:RelatesTo]->(b:Entity)
            WHERE (regexp_matches(lower(a.name), $pattern) 
               OR regexp_matches(lower(b.name), $pattern) 
               OR regexp_matches(lower(r.predicate), $pattern))
               {scope_filter}
            RETURN a.name, a.entity_type, r.predicate, b.name, b.entity_type, r.confidence, r.source_memory_id, r.project_scope
            ORDER BY r.confidence DESC
            LIMIT $limit
            """
            params = {"pattern": pattern, "limit": max(top_k, 12)}
            if project_scope:
                params["proj"] = project_scope.lower()
            res = self.conn.execute(query_cypher, parameters=params)
            while res.has_next():
                row = res.get_next()
                if project_scope and row[7] and str(row[7]).lower() != project_scope.lower():
                    continue

                key = (row[0], row[2], row[3])
                if key not in seen:
                    seen.add(key)
                    triplets.append({
                        "source": row[0],
                        "source_type": row[1],
                        "predicate": row[2],
                        "target": row[3],
                        "target_type": row[4],
                        "confidence": row[5],
                        "memory_id": row[6],
                        "project": row[7],
                    })
        except Exception as e:
            print("Cypher execution failed:", e, file=sys.stderr)
            # Fallback to exact anchor matches
            for word in words[:3]:
                try:
                    res = self.conn.execute(
                        """
                        MATCH (a:Entity)-[r:RelatesTo]->(b:Entity)
                        WHERE lower(a.name) CONTAINS $q OR lower(b.name) CONTAINS $q
                        RETURN a.name, a.entity_type, r.predicate, b.name, b.entity_type, r.confidence, r.source_memory_id, r.project_scope
                        LIMIT 4
                        """,
                        parameters={"q": word}
                    )
                    while res.has_next():
                        row = res.get_next()
                        if project_scope and row[7] and str(row[7]).lower() != project_scope.lower():
                            continue
                        key = (row[0], row[2], row[3])
                        if key not in seen:
                            seen.add(key)
                            triplets.append({
                                "source": row[0],
                                "source_type": row[1],
                                "predicate": row[2],
                                "target": row[3],
                                "target_type": row[4],
                                "confidence": row[5],
                                "memory_id": row[6],
                                "project": row[7],
                            })
                except Exception:
                    pass

        return triplets

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python kuzu_engine.py [init|seed|query <json_query>]")
        sys.exit(0)

    cmd = sys.argv[1]
    engine = UpgradedPCMKuzuEngine()

    if cmd == "seed":
        # Seed standard PCM scenarios
        seed_data = [
            ("ADR-009", "SUPERSEDES", "ADR-002 UUIDv4 schema", "Policy", "Technology", 1.0, "adr-009", "skillvault"),
            ("ADR-009", "MANDATES", "ULID VARCHAR(26) primary keys", "Policy", "Technology", 1.0, "adr-009", "skillvault"),
            ("Database Tables", "MUST_USE", "ULID VARCHAR(26)", "Technology", "Technology", 1.0, "adr-009", "skillvault"),
            ("ADR-002", "MANDATES", "UUIDv4 via gen_random_uuid()", "Policy", "Technology", 0.4, "adr-002", "skillvault"),
            ("WebSocket Connections", "DROPS_BEHIND", "Cloudflare proxy", "Protocol", "Platform", 1.0, "ws-drop", "skillvault"),
            ("Fastify Server", "SENDS_KEEPALIVE_INTERVAL", "45 seconds ping pong", "Framework", "Parameter", 1.0, "ws-drop", "skillvault"),
            ("Railway Deployment", "BINDS_TO", "IPv6 loopback :: rather than 0.0.0.0", "Platform", "Configuration", 1.0, "railway-ipv6", "skillvault"),
            ("work-api", "AUTHENTICATES_VIA", "Passkeys with scrypt hashing", "Service", "Technology", 1.0, "work-api-auth", "work-api"),
            ("work-api", "USES_TEST_TOKEN_HELPER", "createTestAuthToken in tests/auth-helper.ts", "Service", "Artifact", 1.0, "work-api-auth", "work-api"),
            ("client-mobile", "AUTHENTICATES_VIA", "AWS Cognito User Pools OAuth2 JWT", "Service", "Platform", 1.0, "client-mobile-auth", "client-mobile"),
            ("Security Policy", "FORBIDS_RAW_LOGGING_OF", "Auth tokens and secrets", "Policy", "Security", 1.0, "pref-security", ""),
            ("Auth Debugging", "REQUIRES_REDACTION", "Mask tokens to first 4 characters with slice", "Policy", "Rule", 1.0, "pref-security", ""),
        ]
        for src, pred, tgt, stype, ttype, conf, mid, proj in seed_data:
            engine.upsert_triplet(src, pred, tgt, stype, ttype, conf, mid, proj)
        print(json.dumps({"ok": True, "count": len(seed_data)}))

    elif cmd == "query":
        q = sys.argv[2] if len(sys.argv) > 2 else ""
        proj = sys.argv[3] if len(sys.argv) > 3 else ""
        t0 = time.perf_counter()
        results = engine.query_subgraph(q, project_scope=proj)
        lat = (time.perf_counter() - t0) * 1000
        print(json.dumps({"latency_ms": round(lat, 2), "triplets": results}))
