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
            ]
            for src, pred, tgt, stype, ttype, conf, mid, proj in seed_data:
                engine.upsert_triplet(src, pred, tgt, stype, ttype, conf, mid, proj)
            response = json.dumps({"ok": True, "count": len(seed_data)}).encode("utf-8")
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
