#!/usr/bin/env python3
"""
Humdard Analytics — local proxy server.
Serves dashboard.html and proxies Cloudflare Analytics Engine SQL queries
so the browser never touches the CF API directly (avoids CORS).

Usage:
  CF_ACCOUNT_ID=<id> CF_API_TOKEN=<token> python3 serve.py
  open http://localhost:8765/dashboard.html
"""

import http.server
import urllib.request
import urllib.error
import json
import os
import sys

PORT          = int(os.environ.get('PORT', 8765))
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '43fa41462cbf2aebf63050dd37ec30e3').strip()
CF_API_TOKEN  = os.environ.get('CF_API_TOKEN', '').strip()
CF_SQL_URL    = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/analytics_engine/sql'


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != '/cf-query':
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length)
        try:
            sql = json.loads(raw).get('query', '')
        except Exception:
            sql = raw.decode()

        req = urllib.request.Request(
            CF_SQL_URL,
            data=sql.encode(),
            headers={
                'Authorization': f'Bearer {CF_API_TOKEN}',
                'Content-Type': 'text/plain',
            },
            method='POST',
        )

        try:
            with urllib.request.urlopen(req) as resp:
                body = resp.read()
                self.send_response(200)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)

        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        if args and len(args) > 1 and str(args[1]) >= '400':
            super().log_message(fmt, *args)


if __name__ == '__main__':
    print(f'humdard analytics → http://localhost:{PORT}/dashboard.html')
    with http.server.HTTPServer(('', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')
