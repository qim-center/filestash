# QIM Center Filestash

This repository is a **QIM Center fork** of the original [Filestash](https://github.com/mickael-kerjean/filestash) project.

Filestash remains the upstream foundation. This fork keeps compatibility with Filestash while adding QIM-specific UX and workflow improvements.

## What This Fork Adds

- **Copy Path**: Copy the full path of a file or folder directly from the UI.
- **Permissions**: View and edit file mode permissions from the file browser.
- **Volume Explorer**: Volumetric data visualization. Works with OME-Zarr v2 and v3.
- **Notebook Viewer**: Read-only Jupyter Notebook (`.ipynb`) rendering directly in Filestash.

The plugin bundles the published `@qim3d/volume-explorer` web app and integrates it with Filestash session-backed file access.

## Installation and Build

### Prerequisites
- `git`
- `make`
- `go`
- a C toolchain for CGO (for example `gcc`)
- `curl`, `tar`, and `zip` (required for the Volume Explorer plugin packaging)

### Build the Main Application

```bash
git clone https://github.com/qim-center/filestash
cd filestash

# Fetch dependencies and run code generation
make init

# Build Filestash binary
make build
```

This creates:
- `dist/filestash`

### Build and Install Plugins

```bash
# Volume Explorer
cd server/plugin/plg_application_volumeexplorer
make install
cd ../../..

# Notebook Viewer (.ipynb)
cd server/plugin/plg_application_notebookviewer
make install
cd ../../..
```

### Run

From repository root:

```bash
./dist/filestash
```

Then open Filestash in your browser.

### Typical Local Dev Workflow

```bash
# If generated sources changed (for example MIME mappings), run this first:
make init

# Rebuild backend
make build

# Reinstall plugin(s) after changes:
cd server/plugin/plg_application_volumeexplorer && make install && cd ../../..
cd server/plugin/plg_application_notebookviewer && make install && cd ../../..

# Run app
./dist/filestash
```

## Upstream Reference

Original project:
- https://github.com/mickael-kerjean/filestash

When syncing with upstream, keep this README focused on fork-specific behavior and build steps for QIM Center additions.
