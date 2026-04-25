.PHONY: format
format:
	ruff check --fix; ruff format

.PHONY: typecheck
typecheck:
	pyrefly check
