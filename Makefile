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
USER_ID ?=
SANDBOX_ID ?= node_$(USER)
DAEMON_TOKEN ?=
DAEMON_NODE_TOKEN ?=
SANDBOX_MODE ?=
WORKSPACE ?=
SUPERVISOR_PROVIDER ?= local
SUPERVISOR_COMMAND ?=
# Unset = the supervisor default (.relay/user-workspaces, or the pre-rename
# .relay/employee-workspaces when only that exists).
SUPERVISOR_WORKSPACE_ROOT ?= .relay/user-workspaces
SUPERVISOR_INTERVAL_MS ?=
SUPERVISOR_ONCE ?=
ADMIN_TOKEN ?=
# The installer every `relay update` downloads. Rebuilt whenever the client
# sources are newer, or the backend would keep handing computers an old client.
COMPUTER_BUNDLE := backend/relay/computer/daemon.tar.gz
COMPUTER_BUNDLE_SOURCES := $(shell find packages/relay-core/src packages/relay-daemon/src -name '*.ts') \
	packages/relay-core/package.json packages/relay-daemon/package.json tools/build-computer.mjs

.PHONY: cloud-computer-image devbox-image devbox-check devbox-oci build-packages test test-e2e test-python backend-install backend backend-test backend-migrate backend-worker pre-commit-install pre-commit-run daemon-install daemon-test daemon supervisor-install supervisor-test supervisor serve web-install web-test web run-fresh stop

devbox-image:
	docker build --build-arg DEVBOX_BASE_IMAGE="$(DEVBOX_BASE_IMAGE)" -t $(DEVBOX_IMAGE) -f $(DOCKERFILE) .

# Fly Machines run linux/amd64. Push the result to registry.fly.io/<app>:<tag>
# and point the supervisor's RELAY_FLY_IMAGE at it (docs/deployment.md).
CLOUD_COMPUTER_IMAGE ?= relay-cloud-computer:latest
cloud-computer-image:
	docker build --platform linux/amd64 --build-arg DEVBOX_BASE_IMAGE="$(DEVBOX_BASE_IMAGE)" -t relay-devbox:amd64 -f $(DOCKERFILE) .
	docker build --platform linux/amd64 -t $(CLOUD_COMPUTER_IMAGE) -f deploy/cloud-computer/Dockerfile .

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

# The web e2e suite (Playwright against the production export). `pretest:e2e`
# builds the export first; there is no CI, so run this before handing off web work.
test-e2e:
	npm run test:e2e -w web

test-python: backend-test

backend-install:
	UV_CACHE_DIR=.uv-cache uv sync --project backend --extra dev

pre-commit-install: backend-install
	UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pre-commit install

pre-commit-run:
	UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pre-commit run --all-files

# A failed build must not keep the backend down; its startup check names the
# stale bundle instead, and the next `make backend` tries again.
$(COMPUTER_BUNDLE): $(COMPUTER_BUNDLE_SOURCES)
	-npm run build:computer

backend: $(COMPUTER_BUNDLE)
	$(if $(filter command line environment,$(origin BACKEND_PORT)),BACKEND_PORT="$(BACKEND_PORT)" )UV_CACHE_DIR=.uv-cache uv run --project backend relay

backend-test:
	UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests

backend-migrate:
	$(if $(DATABASE_URL),RELAY_DATABASE_URL="$(DATABASE_URL)" )UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev alembic -c backend/alembic.ini upgrade head

backend-worker:
	$(if $(DATABASE_URL),RELAY_DATABASE_URL="$(DATABASE_URL)" )UV_CACHE_DIR=.uv-cache uv run --project backend relay worker-schema
	$(if $(DATABASE_URL),RELAY_DATABASE_URL="$(DATABASE_URL)" )UV_CACHE_DIR=.uv-cache uv run --project backend relay worker

daemon-install:
	npm install -w relay-daemon

daemon:
	@echo "Starting the Relay daemon. It registers with the backend, owns the sandbox, and runs agent CLIs."
	$(if $(filter command line environment,$(origin RELAY_BACKEND_URL)),RELAY_BACKEND_URL="$(RELAY_BACKEND_URL)" )$(if $(filter command line environment,$(origin EMPLOYEE_ID)),RELAY_USER_ID="$(EMPLOYEE_ID)" )$(if $(filter command line environment,$(origin USER_ID)),RELAY_USER_ID="$(USER_ID)" )$(if $(filter command line environment,$(origin DAEMON_TOKEN)),RELAY_DAEMON_TOKEN="$(DAEMON_TOKEN)" )$(if $(filter command line environment,$(origin DAEMON_NODE_TOKEN)),RELAY_DAEMON_NODE_TOKEN="$(DAEMON_NODE_TOKEN)" )$(if $(filter command line environment,$(origin WORKSPACE)),RELAY_WORKSPACE="$(WORKSPACE)" )node packages/relay-daemon/dist/cli.js --sandbox-id $(SANDBOX_ID) $(if $(filter command line environment,$(origin SANDBOX_MODE)),--sandbox $(SANDBOX_MODE),)

daemon-test:
	npm run build -w relay-core
	npm run build -w relay-daemon
	./node_modules/.bin/tsc -p packages/tsconfig.json
	node --test dist/packages/relay-core/tests/handoff.test.js

supervisor-install:
	npm install -w relay-supervisor

supervisor:
	@echo "Starting the Relay supervisor. It provisions user daemon nodes and launches them through the selected provider."
	PATH="$(CURDIR)/node_modules/.bin:$$PATH" $(if $(filter command line environment,$(origin RELAY_BACKEND_URL)),RELAY_BACKEND_URL="$(RELAY_BACKEND_URL)" )$(if $(filter command line environment,$(origin ADMIN_TOKEN)),RELAY_ADMIN_TOKEN="$(ADMIN_TOKEN)" )$(if $(filter command line environment,$(origin SUPERVISOR_PROVIDER)),RELAY_SUPERVISOR_PROVIDER="$(SUPERVISOR_PROVIDER)" )$(if $(filter command line environment,$(origin SUPERVISOR_COMMAND)),RELAY_SUPERVISOR_COMMAND="$(SUPERVISOR_COMMAND)" )$(if $(filter command line environment,$(origin SUPERVISOR_WORKSPACE_ROOT)),RELAY_SUPERVISOR_WORKSPACE_ROOT="$(SUPERVISOR_WORKSPACE_ROOT)" )node packages/relay-supervisor/dist/cli.js $(if $(filter command line environment,$(origin SANDBOX_MODE)),--sandbox $(SANDBOX_MODE),) $(if $(filter command line environment,$(origin SUPERVISOR_INTERVAL_MS)),--interval-ms $(SUPERVISOR_INTERVAL_MS),) $(if $(SUPERVISOR_ONCE),--once,)

supervisor-test:
	npm run build -w relay-core
	npm run build -w relay-supervisor
	./node_modules/.bin/tsc -p packages/tsconfig.json
	node --test dist/packages/relay-supervisor/tests/supervisor.test.js

serve: $(COMPUTER_BUNDLE)
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
