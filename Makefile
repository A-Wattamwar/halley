.PHONY: up down logs smoke clean fmt lint ps ready help

# Default target: show available commands.
help:
	@echo "Halley — local dev targets"
	@echo ""
	@echo "  make up       Start the full compose stack in the background"
	@echo "  make down     Stop the stack (preserves volumes)"
	@echo "  make clean    Stop the stack and remove volumes (destroys data)"
	@echo "  make logs     Tail logs from all services"
	@echo "  make ps       Show compose service status"
	@echo "  make ready    Wait until all services report healthy"
	@echo "  make smoke    Run the ingester smoke test (Week 1 Day 7)"
	@echo "  make fmt      Format Rust sources in ingester/"
	@echo "  make lint     Run clippy on ingester/ (deny warnings)"

up:
	docker compose up -d

down:
	docker compose down

clean:
	docker compose down -v

logs:
	docker compose logs -f

ps:
	docker compose ps

# Block until every service with a healthcheck reports healthy, or fail.
# Useful in CI and after `make up` to gate subsequent steps.
ready:
	@echo "Waiting for services to report healthy..."
	@for i in $$(seq 1 60); do \
		unhealthy=$$(docker compose ps --format '{{.Service}} {{.Health}}' \
			| awk '$$2 != "healthy" && $$2 != "" {print $$1}'); \
		if [ -z "$$unhealthy" ]; then \
			echo "All services healthy."; \
			exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "Timed out waiting for services:"; \
	docker compose ps; \
	exit 1

smoke:
	bash ingester/tests/smoke.sh

fmt:
	cd ingester && cargo fmt --all

lint:
	cd ingester && cargo clippy --all-targets -- -D warnings
