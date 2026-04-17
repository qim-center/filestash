PACKAGE_VERSION ?= 0.4.0-rc.1
PACKAGE_URL = https://registry.npmjs.org/ipynb2html/-/ipynb2html-$(PACKAGE_VERSION).tgz
PLUGIN_NAME = application_notebookviewer.zip
PLUGIN_DIST = ../../../dist/data/state/plugins
PLUGIN_LOCAL = ../../../state/plugins

all: clean setup build

clean:
	rm -f $(PLUGIN_NAME)

setup:
	mkdir -p lib/vendor
	curl -L $(PACKAGE_URL) | tar -xzf - --strip-components=2 -C lib/vendor package/dist/ipynb2html-full.min.js package/dist/notebook.min.css
	curl -L https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css > lib/vendor/katex.min.css
	curl -L https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/default.min.css > lib/vendor/highlight.min.css

build:
	zip -r $(PLUGIN_NAME) manifest.json loader_ipynb.js loader_ipynb.css lib

install: build
	mkdir -p $(PLUGIN_DIST)
	cp -f $(PLUGIN_NAME) $(PLUGIN_DIST)/

install-local: build
	mkdir -p $(PLUGIN_LOCAL)
	cp -f $(PLUGIN_NAME) $(PLUGIN_LOCAL)/
