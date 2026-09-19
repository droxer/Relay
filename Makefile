DEVBOX_IMAGE := relay-devbox:v1
DEVBOX_BASE_IMAGE ?= node:22.19-bookworm-slim
OCI_DIR := .oci/relay-devbox-v1
DOCKERFILE := dockerfile
IMAGE_ID_FILE := $(OCI_DIR)/.docker-image-id
DOCKERFILE_MTIME_FILE := $(OCI_DIR)/.dockerfile-mtime
PORT ?= 8787
BACKEND_PORT ?= 8790
DATABASE_URL ?=
RELAY_BACKEND_URL ?= http://127.0.0.1:$(BACKEND_PORT)
EMPLOYEE_ID ?=
SANDBOX_ID ?= node_$(USER)
DAEMON_TOKEN ?=
DAEMON_NODE_TOKEN ?=
SANDBOX_MODE ?=
WORKSPACE ?=
SUPERVISOR_PROVIDER ?= local
SUPERVISOR_COMMAND ?=
SUPERVISOR_WORKSPACE_ROOT ?= .relay/employee-workspaces
SUPERVISOR_INTERVAL_MS ?=
SUPERVISOR_ONCE ?=
ADMIN_TOKEN ?=

.PHONY: devbox-image devbox-check devbox-oci build-packages test test-python backend-install backend backend-test backend-migrate pre-commit-install pre-commit-run daemon-install daemon-test daemon supervisor-install supervisor-test supervisor serve web-install web-test web run-fresh stop

devbox-image:
	docker build --build-arg DEVBOX_BASE_IMAGE="$(DEVBOX_BASE_IMAGE)" -t $(DEVBOX_IMAGE) -f $(DOCKERFILE) .

devbox-check: devbox-image
	docker run --rm $(DEVBOX_IMAGE) bash -lc 'node --version && command -v pi && pi --version && claude --version && codex --version && kimi --version'

devbox-oci: devbox-check
	mkdir -p $(OCI_DIR)
	docker save $(DEVBOX_IMAGE) | tar -xf - -C $(OCI_DIR)
	docker image inspect $(DEVBOX_IMAGE) --format='{{.Id}}' > $(IMAGE_ID_FILE)
	node -e "console.log(require('fs').statSync('$(DOCKERFILE)', { bigint: true }).mtimeNs.toString())" > $(DOCKERFILE_MTIME_FILE)

build-packages:
	npm run build -w relay-core
	npm run build -w relay-daemon
	npm run build -w relay-supervisor
	node tools/build-computer.mjs

test:
	npm test

test-python: backend-test

backend-install:
	UV_CACHE_DIR=.uv-cache uv sync --project backend --extra dev

pre-commit-install: backend-install
	UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pre-commit install

pre-commit-run:
	UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pre-commit run --all-files

backend:
	$(if $(filter command line environment,$(origin BACKEND_PORT)),BACKEND_PORT="$(BACKEND_PORT)" )UV_CACHE_DIR=.uv-cache uv run --project backend relay

backend-test:
	UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests

backend-migrate:
	$(if $(DATABASE_URL),RELAY_DATABASE_URL="$(DATABASE_URL)" )UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev alembic -c backend/alembic.ini upgrade head

daemon-install:
	npm install -w relay-daemon

daemon:
	@echo "Starting the Relay daemon. It registers with the backend, owns the sandbox, and runs agent CLIs."
	$(if $(filter command line environment,$(origin RELAY_BACKEND_URL)),RELAY_BACKEND_URL="$(RELAY_BACKEND_URL)" )$(if $(filter command line environment,$(origin EMPLOYEE_ID)),RELAY_EMPLOYEE_ID="$(EMPLOYEE_ID)" )$(if $(filter command line environment,$(origin DAEMON_TOKEN)),RELAY_DAEMON_TOKEN="$(DAEMON_TOKEN)" )$(if $(filter command line environment,$(origin DAEMON_NODE_TOKEN)),RELAY_DAEMON_NODE_TOKEN="$(DAEMON_NODE_TOKEN)" )$(if $(filter command line environment,$(origin WORKSPACE)),RELAY_WORKSPACE="$(WORKSPACE)" )node packages/relay-daemon/dist/cli.js --sandbox-id $(SANDBOX_ID) $(if $(filter command line environment,$(origin SANDBOX_MODE)),--sandbox $(SANDBOX_MODE),)

daemon-test:
	npm run build -w relay-core
	npm run build -w relay-daemon
	./node_modules/.bin/tsc -p packages/tsconfig.json
	node --test dist/packages/relay-core/tests/handoff.test.js

supervisor-install:
	npm install -w relay-supervisor

supervisor:
	@echo "Starting the Relay supervisor. It provisions employee daemon nodes and launches them through the selected provider."
	PATH="$(CURDIR)/node_modules/.bin:$$PATH" $(if $(filter command line environment,$(origin RELAY_BACKEND_URL)),RELAY_BACKEND_URL="$(RELAY_BACKEND_URL)" )$(if $(filter command line environment,$(origin ADMIN_TOKEN)),RELAY_ADMIN_TOKEN="$(ADMIN_TOKEN)" )$(if $(filter command line environment,$(origin SUPERVISOR_PROVIDER)),RELAY_SUPERVISOR_PROVIDER="$(SUPERVISOR_PROVIDER)" )$(if $(filter command line environment,$(origin SUPERVISOR_COMMAND)),RELAY_SUPERVISOR_COMMAND="$(SUPERVISOR_COMMAND)" )$(if $(filter command line environment,$(origin SUPERVISOR_WORKSPACE_ROOT)),RELAY_SUPERVISOR_WORKSPACE_ROOT="$(SUPERVISOR_WORKSPACE_ROOT)" )node packages/relay-supervisor/dist/cli.js $(if $(filter command line environment,$(origin SANDBOX_MODE)),--sandbox $(SANDBOX_MODE),) $(if $(filter command line environment,$(origin SUPERVISOR_INTERVAL_MS)),--interval-ms $(SUPERVISOR_INTERVAL_MS),) $(if $(SUPERVISOR_ONCE),--once,)

supervisor-test:
	npm run build -w relay-core
	npm run build -w relay-supervisor
	./node_modules/.bin/tsc -p packages/tsconfig.json
	node --test dist/packages/relay-supervisor/tests/supervisor.test.js

serve:
	$(if $(filter command line environment,$(origin PORT)),BACKEND_PORT="$(PORT)" )UV_CACHE_DIR=.uv-cache uv run --project backend relay serve

web-install:
	npm install -w web

web:
	$(if $(filter command line environment,$(origin RELAY_BACKEND_URL)),RELAY_BACKEND_URL="$(RELAY_BACKEND_URL)" )npm run dev -w web

web-test:
	npm run build -w relay-core
	./node_modules/.bin/tsc -p packages/tsconfig.json
	node --test dist/web/tests/status.test.js dist/web/tests/messageBlock.test.js

run-fresh: devbox-oci

stop:
	-pkill -f "uv run --project backend relay" 2>/dev/null
	-pkill -f "backend --port" 2>/dev/null
	-pkill -f "node packages/relay-daemon/dist/cli.js" 2>/dev/null
	-pkill -f "node packages/relay-supervisor/dist/cli.js" 2>/dev/null
	-pkill -f "boxlite-shim" 2>/dev/null
	-node -e "import('@boxlite-ai/boxlite').then(async ({JsBoxlite}) => { const rt = JsBoxlite.withDefaultConfig(); for (const box of await rt.listInfo()) { if ((box.name || '').startsWith('relay')) await rt.remove(box.name || box.id, true).catch(() => undefined); } }).catch(() => undefined)"
	-rm -f $(HOME)/.boxlite/.lock
	@echo "Stopped Relay backend, daemon, supervisor, and BoxLite processes."
