SHELL := /usr/bin/env bash

.PHONY: help test

help:
	@echo "make test"

test:
	@PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_project_workspace.py'
