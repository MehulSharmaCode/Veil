PY := server/.venv/bin/python

.PHONY: setup ext ext-watch server demo dashboard dev test test-ext test-server typecheck leaks

setup:
	cd extension && npm install
	python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
	test -f server/.env || cp server/.env.example server/.env

ext:
	cd extension && node build.mjs

ext-watch:
	cd extension && node build.mjs --watch

server:
	cd server && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000

demo:
	python3 -m http.server 8080 --bind 127.0.0.1 --directory demo-site

dashboard:
	python3 -m http.server 8090 --bind 127.0.0.1 --directory dashboard

# All three servers in one terminal (Ctrl-C stops all).
dev: ext
	trap 'kill 0' INT TERM; $(MAKE) server & $(MAKE) demo & $(MAKE) dashboard & wait

typecheck:
	cd extension && npx tsc --noEmit

test-ext:
	cd extension && npx vitest run

test-server:
	cd server && .venv/bin/python -m pytest -q

test: typecheck test-ext test-server

leaks:
	$(PY) scripts/check_leaks.py --telemetry
