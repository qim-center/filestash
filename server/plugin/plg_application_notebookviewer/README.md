# Notebook Viewer Filestash Plugin

This plugin adds a read-only viewer for Jupyter notebooks (`.ipynb`) using
the `ipynb2html` renderer.

The plugin follows the same packaging model as other Filestash app plugins:
- `manifest.json`
- Filestash loader (`loader_ipynb.js`)
- bundled frontend assets in `lib/vendor`

## Build

```sh
cd server/plugin/plg_application_notebookviewer
make
```

## Install into the Filestash dist tree

```sh
cd server/plugin/plg_application_notebookviewer
make install
```

For a local (non-`dist`) install:

```sh
make install-local
```
