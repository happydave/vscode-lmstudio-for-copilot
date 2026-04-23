.PHONY: install compile watch package clean test lint docker-build docker-shell

# Install dependencies via npm inside Docker
install:
	docker run --rm -v $(shell pwd):/workspace -w /workspace node:lts-alpine sh -c "npm install"

# Compile TypeScript in Docker container
compile:
	docker run --rm -v $(shell pwd):/workspace -w /workspace node:lts-alpine npx tsc -p .

# Watch mode for development (requires TTY)
watch:
	docker run --rm -it -v $(shell pwd):/workspace -w /workspace node:lts-alpine npx tsc -watch -p .

# Build VSIX package in Docker container
package:
	docker run --rm -v $(shell pwd):/workspace -w /workspace node:lts-alpine npx vsce package --no-dependencies

# Clean build artifacts (run on host)
clean:
	rm -rf node_modules dist out *.vsix .vscode-test

# Run unit tests in Docker container
test:
	docker run --rm -v $(shell pwd):/workspace -w /workspace node:lts-alpine npm test

# Lint TypeScript files via ESLint
lint:
	docker run --rm -v $(shell pwd):/workspace -w /workspace node:lts-alpine npx eslint src --ext ts

# Build Docker container for development
docker-build:
	docker build -f Dockerfile.dev -t lmstudio-copilot-dev .

# Open interactive shell in Docker container
docker-shell:
	docker run --rm -it -v $(shell pwd):/workspace -w /workspace node:lts-alpine sh
