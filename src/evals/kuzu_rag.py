import os
import shutil
import sys
import json
import time
import kuzu

KUZU_DIR = os.path.join(os.path.dirname(__file__), "data", "kuzu_eval_db")

def init_kuzu_db():
    if os.path.exists(KUZU_DIR):
        if os.path.isdir(KUZU_DIR):
            shutil.rmtree(KUZU_DIR)
        else:
            os.remove(KUZU_DIR)
    os.makedirs(os.path.dirname(KUZU_DIR), exist_ok=True)

    db = kuzu.Database(KUZU_DIR)
    conn = kuzu.Connection(db)

    conn.execute("CREATE NODE TABLE Entity(name STRING, PRIMARY KEY (name))")
    conn.execute("CREATE REL TABLE Relationship(FROM Entity TO Entity, predicate STRING, confidence DOUBLE, source_chunk STRING)")
    return db, conn

def store_triplet(conn, subj, pred, obj, confidence=1.0, source="eval"):
    for ent in [subj, obj]:
        try:
            conn.execute("CREATE (:Entity {name: $name})", parameters={"name": str(ent)})
        except Exception:
            pass

    try:
        conn.execute(
            """
            MATCH (a:Entity {name: $subj}), (b:Entity {name: $obj})
            CREATE (a)-[:Relationship {predicate: $pred, confidence: $conf, source_chunk: $src}]->(b)
            """,
            parameters={"subj": str(subj), "pred": str(pred), "obj": str(obj), "conf": float(confidence), "src": str(source)}
        )
    except Exception as e:
        pass

def seed_graph(conn):
    triplets = [
        # Scenario 1: Migration (New ULID vs Obsolete UUIDv4)
        ("ADR-009", "mandates_primary_key", "ULID VARCHAR(26) primary key", 1.0, "adr-009"),
        ("Database Tables", "must_use", "ULID VARCHAR(26)", 1.0, "adr-009"),
        ("ADR-009", "supersedes", "ADR-002 UUIDv4 schema", 1.0, "adr-009"),
        ("ADR-002", "mandates_primary_key", "UUIDv4 gen_random_uuid()", 0.5, "adr-002"),
        ("PostgreSQL Tables", "use_primary_key", "UUIDv4 via gen_random_uuid", 0.5, "adr-002"),

        # Scenario 2: Multi-Session Production Bug (WebSocket + Railway)
        ("WebSocket Connections", "dropouts_behind", "Cloudflare reverse proxy", 1.0, "ws-drop"),
        ("Cloudflare Proxy", "requires_keepalive_interval", "45 seconds ping pong", 1.0, "ws-drop"),
        ("Railway Deployment", "requires_binding", "IPv6 loopback :: rather than 0.0.0.0", 1.0, "railway-ipv6"),
        ("Railway Private Networking", "routes_over", "IPv6 loopback ::", 1.0, "railway-ipv6"),

        # Scenario 3: Multi-Repo Disambiguation
        ("work-api", "authentication_mechanism", "Passkeys with scrypt hashing", 1.0, "work-api"),
        ("work-api", "test_token_helper", "createTestAuthToken in tests/auth-helper.ts", 1.0, "work-api"),
        ("client-mobile", "authentication_mechanism", "AWS Cognito User Pools OAuth2 JWT", 1.0, "client-mobile"),
        ("client-mobile", "test_token_helper", "getCognitoTestJwt in Flutter test utils", 1.0, "client-mobile"),

        # Scenario 4: Critical Security Invariant
        ("Auth Tokens and Secrets", "must_never_be", "Logged, Echoed, or Written Raw", 1.0, "pref-security"),
        ("Auth Debugging", "requires_redaction", "Mask tokens to first 4 characters with slice", 1.0, "pref-security"),
    ]

    for subj, pred, obj, conf, src in triplets:
        store_triplet(conn, subj, pred, obj, conf, src)

def graph_search(conn, query, top_k=5):
    words = [w.lower() for w in query.strip().split() if len(w) > 3]
    triplets = []
    seen = set()

    for word in words:
        try:
            res = conn.execute(
                """
                MATCH (a:Entity)-[r:Relationship]->(b:Entity)
                WHERE lower(a.name) CONTAINS $q OR lower(b.name) CONTAINS $q OR lower(r.predicate) CONTAINS $q
                RETURN a.name, r.predicate, b.name, r.confidence, r.source_chunk
                ORDER BY r.confidence DESC
                LIMIT $limit
                """,
                parameters={"q": word, "limit": top_k}
            )
            while res.has_next():
                row = res.get_next()
                key = (row[0], row[1], row[2])
                if key not in seen:
                    seen.add(key)
                    triplets.append({
                        "subject": row[0],
                        "predicate": row[1],
                        "object": row[2],
                        "confidence": row[3],
                        "source": row[4],
                    })
        except Exception:
            pass

    return triplets

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "query"

    if action == "seed_and_query":
        query = sys.argv[2] if len(sys.argv) > 2 else ""
        db, conn = init_kuzu_db()
        seed_graph(conn)

        start = time.perf_counter()
        results = graph_search(conn, query)
        duration_ms = (time.perf_counter() - start) * 1000

        output = {
            "query": query,
            "latency_ms": round(duration_ms, 3),
            "results": results,
            "text": " ".join([f"{r['subject']} {r['predicate']} {r['object']}" for r in results])
        }
        print(json.dumps(output))
