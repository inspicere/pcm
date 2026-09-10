import os
import sys
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from kuzu_engine import UpgradedPCMKuzuEngine

engine = UpgradedPCMKuzuEngine()

class KuzuHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress standard request logging for max speed
        pass

    def do_POST(self):
        if self.path.startswith("/query"):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            payload = json.loads(body) if body else {}
            
            q = payload.get("query", "")
            proj = payload.get("project_scope", "")
            
            t0 = time.perf_counter()
            triplets = engine.query_subgraph(q, project_scope=proj)
            latency_ms = (time.perf_counter() - t0) * 1000

            response = json.dumps({
                "latency_ms": round(latency_ms, 3),
                "triplets": triplets
            }).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        elif self.path.startswith("/seed"):
            # Seed data
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
                # Conversational Triplet Seeds
                ("Jordan", "ALLERGIC_TO", "Shellfish and oysters", "Person", "Medical", 1.0, "jordan-allergy", ""),
                ("Jordan", "CARRIES", "EpiPen everywhere", "Person", "Medical", 1.0, "jordan-allergy", ""),
                ("Jordan", "RESIDENCE_ACTIVE", "Denver Colorado", "Person", "Location", 1.0, "jordan-denver", ""),
                ("Jordan", "EXERCISE_ACTIVE", "Swimming at indoor pool", "Person", "Activity", 1.0, "jordan-denver", ""),
                ("Denver Residence", "SUPERSEDES", "Austin Residence", "State", "State", 1.0, "jordan-denver", ""),
                ("Swimming Exercise", "SUPERSEDES", "Marathon Running", "State", "State", 1.0, "jordan-denver", ""),
                ("Alex", "PROFESSION", "Commercial Architect", "Person", "Career", 1.0, "alex-architect", ""),
                ("Jordan and Alex", "MARRIAGE_ANNIVERSARY", "September 18 10-year", "Event", "Date", 1.0, "jordan-anniv", ""),
                ("Jordan", "FOOD_RESTRICTION", "Violent food poisoning from Thai green curry", "Person", "Health", 1.0, "jordan-thai", ""),
                ("Thai Cuisine", "FORBIDDEN_DUE_TO", "Severe food poisoning", "Food", "Reason", 1.0, "jordan-thai", ""),
                ("Jordan Career", "ACTIVE_ROLE", "Founder and CTO of CogMesh AI", "Career", "Company", 1.0, "jordan-cogmesh", ""),
                ("CogMesh AI", "SUPERSEDES", "FinTech Corp VP Engineering", "State", "State", 1.0, "jordan-cogmesh", ""),
                ("Jordan Health", "CONFIDENTIAL_INVARIANT", "Prescribed Lexapro strictly never disclose", "Medical", "Privacy", 1.0, "jordan-privacy", ""),
            ]
            for src, pred, tgt, stype, ttype, conf, mid, proj in seed_data:
                engine.upsert_triplet(src, pred, tgt, stype, ttype, conf, mid, proj)
            response = json.dumps({"ok": True, "count": len(seed_data)}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        elif self.path.startswith("/upsert"):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            payload = json.loads(body) if body else {}

            triplets = payload.get("triplets", [])
            inserted = 0
            for t in triplets:
                engine.upsert_triplet(
                    source=t.get("source", ""),
                    predicate=t.get("predicate", ""),
                    target=t.get("target", ""),
                    source_type=t.get("source_type", "Entity"),
                    target_type=t.get("target_type", "Entity"),
                    confidence=float(t.get("confidence", 1.0)),
                    memory_id=t.get("memory_id", ""),
                    project=t.get("project", "")
                )
                inserted += 1

            response = json.dumps({"ok": True, "inserted": inserted}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = HTTPServer(("127.0.0.1", port), KuzuHandler)
    print(f"Kùzu daemon listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
