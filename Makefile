.PHONY: format
format:
	ruff check --fix; ruff format
	npx oxlint --fix src/rando_recap/static; npx oxfmt src/rando_recap/static

.PHONY: lint
lint:
	ruff check
	npx oxlint src/rando_recap/static

.PHONY: typecheck
typecheck:
	pyrefly check
