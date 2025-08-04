# serve.py -- resilient local server (auto-picks port, safe stop)
import http.server, socketserver, socket, os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript'}  # iOS MIME fix

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True
    def server_bind(self):
        # Help avoid "already in use" after quick restarts
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            # SO_REUSEPORT (may not exist; ignore if it doesn't)
            self.socket.setsockopt(socket.SOL_SOCKET, 0x200, 1)
        except Exception:
            pass
        super().server_bind()

def pick_port(start=8000, count=50):
    for p in range(start, start+count):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("No free port found")

PORT = pick_port(8000)
with ReusableTCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Serving {ROOT} on http://127.0.0.1:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print("Server stopped cleanly.")