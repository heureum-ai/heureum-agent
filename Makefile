.PHONY: help setup install install-agent install-mcp install-platform install-frontend install-client install-client-tools install-mobile
.PHONY: dev-agent dev-mcp dev-platform dev-frontend dev-client dev-mobile dev-mobile-ios dev-mobile-android dev-all stop
.PHONY: release-client-mac release-client-win
.PHONY: build-agent build-mcp build-platform build-frontend build-client build-client-tools build-all
.PHONY: test-agent test-mcp test-platform test-frontend test-client test-all
.PHONY: lint-frontend lint-client lint-all clean clean-node-modules
.PHONY: docker-build infra-init infra-plan infra-apply

# Default target
help:
	@echo "Heureum Monorepo - Available Commands"
	@echo "======================================"
	@echo ""
	@echo "Quick Start:"
	@echo "  make setup                - Install + migrate + run all services"
	@echo ""
	@echo "Installation:"
	@echo "  make install              - Install all dependencies"
	@echo "  make install-agent        - Install heureum-agent (FastAPI + LangChain)"
	@echo "  make install-mcp          - Install heureum-mcp (MCP server)"
	@echo "  make install-platform     - Install heureum-platform (Django)"
	@echo "  make install-frontend     - Install heureum-frontend (React)"
	@echo "  make install-client-tools  - Install & build heureum-client-tools (coding)"
	@echo "  make install-client       - Install heureum-client (Electron)"
	@echo "  make install-mobile       - Install heureum-mobile (Expo)"
	@echo ""
	@echo "Development:"
	@echo "  make dev-agent            - Run agent development server"
	@echo "  make dev-mcp              - Run MCP server"
	@echo "  make dev-platform         - Run platform development server"
	@echo "  make dev-frontend         - Run frontend development server"
	@echo "  make dev-client           - Run client development mode"
	@echo "  make dev-mobile           - Run mobile app (Expo)"
	@echo "  make dev-mobile-ios       - Run mobile app on iOS simulator"
	@echo "  make dev-mobile-android   - Run mobile app on Android emulator"
	@echo "  make dev-all              - Run all services (requires tmux/parallel)"
	@echo "  make stop                 - Stop all running services"
	@echo ""
	@echo "Build:"
	@echo "  make build-agent          - Build agent"
	@echo "  make build-mcp            - Build MCP server"
	@echo "  make build-platform       - Build platform"
	@echo "  make build-frontend       - Build frontend"
	@echo "  make build-client         - Build client"
	@echo "  make build-all            - Build all projects"
	@echo ""
	@echo "Release:"
	@echo "  make release-client-mac   - Build and package macOS DMG"
	@echo "  make release-client-win   - Build and package Windows NSIS installer"
	@echo ""
	@echo "Testing:"
	@echo "  make test-agent           - Test agent"
	@echo "  make test-mcp             - Test MCP server"
	@echo "  make test-platform        - Test platform"
	@echo "  make test-frontend        - Test frontend"
	@echo "  make test-client          - Test client"
	@echo "  make test-all             - Test all projects"
	@echo ""
	@echo "Linting:"
	@echo "  make lint-frontend        - Lint frontend"
	@echo "  make lint-client          - Lint client"
	@echo "  make lint-all             - Lint all TypeScript projects"
	@echo ""
	@echo "Infrastructure:"
	@echo "  make docker-build         - Build all Docker images locally"
	@echo "  make infra-init           - Initialize Terraform"
	@echo "  make infra-plan           - Plan Terraform changes"
	@echo "  make infra-apply          - Apply Terraform changes"
	@echo ""
	@echo "Clean:"
	@echo "  make clean                - Clean all build artifacts"

# Setup: install + migrate + run all services
setup: install
	@echo "Running database migrations..."
	cd heureum-platform && poetry run python manage.py migrate
	@echo "✓ Setup complete. Starting all services..."
	@$(MAKE) dev-all

# Installation targets
install: install-agent install-mcp install-platform install-frontend install-client-tools install-client install-mobile
	@echo "✓ All dependencies installed"

install-agent:
	@echo "Installing heureum-agent dependencies..."
	cd heureum-agent && poetry install

install-mcp:
	@echo "Installing heureum-mcp dependencies..."
	cd heureum-mcp && poetry install

install-platform:
	@echo "Installing heureum-platform dependencies..."
	cd heureum-platform && poetry install

install-frontend:
	@echo "Installing heureum-frontend dependencies..."
	cd heureum-frontend && pnpm install

install-client-tools:
	@echo "Installing and building heureum-client-tools..."
	cd heureum-client-tools/coding && pnpm install && pnpm build
	# TODO: document tools temporarily excluded
	# cd heureum-client-tools/word && pnpm install && pnpm build
	# cd heureum-client-tools/pdf && pnpm install && pnpm build
	# cd heureum-client-tools/ppt && pnpm install && pnpm build
	# cd heureum-client-tools/xlsx && pnpm install && pnpm build
	# cd heureum-client-tools/web && pnpm install && pnpm build

install-client: install-client-tools
	@echo "Installing heureum-client dependencies..."
	cd heureum-client && pnpm install

install-mobile:
	@echo "Installing heureum-mobile dependencies..."
	cd heureum-mobile && npm install

# Development targets
dev-agent:
	cd heureum-agent && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

dev-mcp:
	cd heureum-mcp && poetry run python -m src.main

dev-platform:
	cd heureum-platform && poetry run python manage.py runserver 8001

dev-frontend:
	cd heureum-frontend && pnpm dev

dev-client:
	cd heureum-client && pnpm dev

dev-mobile:
	cd heureum-mobile && npx expo start

dev-mobile-ios:
	cd heureum-mobile && npx expo run:ios

dev-mobile-android:
	cd heureum-mobile && npx expo run:android

dev-all:
	@echo "Starting all services... (Press Ctrl+C to stop all)"
	@echo "Agent:    http://localhost:8000"
	@echo "MCP:     http://localhost:3001"
	@echo "Platform: http://localhost:8001"
	@echo "Frontend: http://localhost:5173"
	@echo "Client:  Electron window"
	@trap 'kill 0' EXIT; \
	(cd heureum-agent && poetry run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) & \
	(cd heureum-mcp && poetry run python -m src.main) & \
	(cd heureum-platform && poetry run python manage.py runserver 8001) & \
	(cd heureum-frontend && pnpm dev) & \
	(cd heureum-client && pnpm dev) & \
	wait

# Build targets
build-agent:
	cd heureum-agent && poetry build

build-mcp:
	cd heureum-mcp && poetry build

build-platform:
	cd heureum-platform && poetry build

build-frontend:
	cd heureum-frontend && pnpm build

build-client-tools:
	cd heureum-client-tools/coding && pnpm build
	# TODO: document tools temporarily excluded
	# cd heureum-client-tools/word && pnpm build
	# cd heureum-client-tools/pdf && pnpm build
	# cd heureum-client-tools/ppt && pnpm build
	# cd heureum-client-tools/xlsx && pnpm build
	# cd heureum-client-tools/web && pnpm build

build-client: build-client-tools
	cd heureum-client && pnpm build

build-all: build-agent build-mcp build-platform build-frontend build-client
	@echo "✓ All projects built"

# Release targets (local packaging, no publish)
release-client-mac:
	cd heureum-client && pnpm build:mac

release-client-win:
	cd heureum-client && pnpm build:win

# Test targets
test-agent:
	cd heureum-agent && poetry run pytest

test-mcp:
	cd heureum-mcp && poetry run pytest

test-platform:
	cd heureum-platform && poetry run pytest

test-frontend:
	cd heureum-frontend && pnpm test

test-client:
	cd heureum-client && pnpm test

test-all: test-agent test-mcp test-platform test-frontend test-client
	@echo "✓ All tests passed"

# Lint targets
lint-frontend:
	cd heureum-frontend && pnpm lint

lint-client:
	cd heureum-client && pnpm lint

lint-all: lint-frontend lint-client
	@echo "✓ All linting passed"

# Docker targets
docker-build:
	docker build -t heureum-agent -f heureum-agent/Dockerfile heureum-agent/
	docker build -t heureum-platform -f heureum-platform/Dockerfile heureum-platform/
	docker build -t heureum-frontend -f heureum-frontend/Dockerfile heureum-frontend/
	@echo "✓ All Docker images built"

# Terraform targets
infra-init:
	cd infra && terraform init

infra-plan:
	cd infra && terraform plan

infra-apply:
	cd infra && terraform apply

# Service management
stop:
	@./scripts/stop-all.sh

# Clean targets
clean:
	@echo "Cleaning build artifacts..."
	rm -rf heureum-agent/dist heureum-agent/.pytest_cache heureum-agent/__pycache__
	rm -rf heureum-mcp/dist heureum-mcp/.pytest_cache heureum-mcp/__pycache__
	rm -rf heureum-platform/dist heureum-platform/.pytest_cache heureum-platform/__pycache__
	rm -rf heureum-frontend/dist heureum-frontend/node_modules/.vite
	rm -rf heureum-client-tools/coding/dist
	# TODO: document tools temporarily excluded
	# rm -rf heureum-client-tools/word/dist heureum-client-tools/pdf/dist heureum-client-tools/ppt/dist heureum-client-tools/xlsx/dist heureum-client-tools/web/dist
	rm -rf heureum-client/dist heureum-client/out heureum-client/release heureum-client/node_modules/.vite
	@echo "✓ Clean complete"

clean-node-modules:
	@echo "Removing node_modules..."
	rm -rf heureum-client-tools/coding/node_modules
	# TODO: document tools temporarily excluded
	# rm -rf heureum-client-tools/word/node_modules
	# rm -rf heureum-client-tools/pdf/node_modules
	# rm -rf heureum-client-tools/ppt/node_modules
	# rm -rf heureum-client-tools/xlsx/node_modules
	# rm -rf heureum-client-tools/web/node_modules
	rm -rf heureum-frontend/node_modules
	rm -rf heureum-client/node_modules
	@echo "✓ node_modules removed — run 'make install' to reinstall"
