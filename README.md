# Envelope Tool

Generate smooth, low-resolution "blob" envelope surfaces for user-defined
protein domains from an all-atom PDB structure — think simulated low-resolution
EM-map isosurfaces per domain, not a convex hull. Define domains by chain +
residue range, pick colors and smoothing parameters, and preview the result
live in your browser next to the cartoon structure.

Two ways to use it:
- **Interactive web app** (`server.py`) — upload a PDB, define domains with
  clickable chain chips and residue-range pickers, tweak smoothing parameters,
  and see the generated envelopes rendered live in 3D. Export high-resolution
  meshes in OBJ / STL / PLY / GLB, plus a ready-to-run PyMOL script.
- **Command-line tool** (`envelope.py`) — same pipeline, driven by a YAML
  config, for scripted/batch use.

## Features

- Domains selected by chain (segid) + residue range, each with its own color,
  transparency, and smoothing parameters (or inherit shared defaults).
- Envelopes are built from the protein backbone trace (falling back to CA-only,
  then all-atom for non-protein selections like ligands) so the surface
  follows the fold the way a cartoon representation does, rather than every
  side chain.
- Domains never overlap at their interfaces (Voronoi-partitioned density grid).
- Auto-calibrated isosurface threshold, or set it manually per domain.
- Live 3D viewer (dark / white / transparent background, structure
  show/hide), with a real progress bar while envelopes are computed.
- Export: viewer-resolution OBJ for quick use, plus full-resolution OBJ / STL
  / PLY / GLB per domain, plus a combined PyMOL CGO scene script.
- Save/load a full session (structure + domains + parameters + display
  settings) as one file, to pick up later without redefining anything.

## Requirements

- Python 3.10 or 3.11
- ~500 MB free disk (dependencies + your structures)
- A modern browser (Chrome, Firefox, Edge, Safari) for the web app

Everything below assumes you're comfortable running a few commands in a
terminal. If a command fails, read the **Troubleshooting** section at the
bottom before trying to work around it.

---

## Quick start

Pick your OS. All three end up running the same `server.py`; the only
differences are how you install Python and open a terminal.

### macOS

1. **Install Python** via [Miniconda](https://docs.conda.io/en/latest/miniconda.html)
   (recommended — avoids compiling scientific packages from source):
   ```bash
   curl -L -o miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-$(uname -m).sh
   bash miniconda.sh -b -p "$HOME/miniconda3"
   source "$HOME/miniconda3/bin/activate"
   ```
   (If you already have conda, Homebrew Python, or python.org Python 3.10/3.11,
   you can skip this and use that instead.)

2. **Clone the repo:**
   ```bash
   git clone https://github.com/kairongdong/envelope-tool.git
   cd envelope-tool
   ```

3. **Create an environment and install dependencies:**
   ```bash
   conda create -n envelope python=3.11 -y
   conda activate envelope
   pip install -r requirements.txt
   ```

4. **Run the server:**
   ```bash
   python server.py
   ```

5. Open **http://127.0.0.1:8000** in your browser.

### Ubuntu / Linux

1. **Install prerequisites** (git, build tools for any packages that need to
   compile, and curl):
   ```bash
   sudo apt update
   sudo apt install -y git build-essential curl
   ```

2. **Install Python** via Miniconda (recommended):
   ```bash
   curl -L -o miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
   bash miniconda.sh -b -p "$HOME/miniconda3"
   source "$HOME/miniconda3/bin/activate"
   ```
   (A system Python 3.10/3.11 with `python3-venv` works too — see the
   Troubleshooting note about compiling scientific packages if you go that
   route.)

3. **Clone the repo:**
   ```bash
   git clone https://github.com/<your-username>/envelope-tool.git
   cd envelope-tool
   ```

4. **Create an environment and install dependencies:**
   ```bash
   conda create -n envelope python=3.11 -y
   conda activate envelope
   pip install -r requirements.txt
   ```

5. **Run the server:**
   ```bash
   python server.py
   ```

6. Open **http://127.0.0.1:8000** in your browser.

### Windows

1. **Install Python** via [Miniconda](https://docs.conda.io/en/latest/miniconda.html)
   (recommended — avoids needing Visual C++ build tools to compile scientific
   packages). Download the Windows installer from that page and run it,
   accepting the defaults.

2. **Open "Anaconda Prompt"** from the Start menu (installed alongside
   Miniconda). Run every command below from that prompt.

3. **Clone the repo** (install [Git for Windows](https://git-scm.com/download/win)
   first if `git` isn't recognized):
   ```bat
   git clone https://github.com/<your-username>/envelope-tool.git
   cd envelope-tool
   ```

4. **Create an environment and install dependencies:**
   ```bat
   conda create -n envelope python=3.11 -y
   conda activate envelope
   pip install -r requirements.txt
   ```

5. **Run the server:**
   ```bat
   python server.py
   ```

6. Open **http://127.0.0.1:8000** in your browser.

---

## Using the web app

0. **Resuming a previous session?** Click **Load state** and pick a
   `envelope_state_*.json` file saved from a previous session (see step 7
   below) — it re-uploads the same structure, restores every domain exactly
   as configured, and restores the display settings, in one step. Otherwise,
   start at step 1.
1. **Upload a structure** — drag a `.pdb` file onto the drop zone, or click it
   to choose a file. The chains and residue ranges found in the file appear
   below it, and the cartoon loads in the 3D viewer.
2. **Define domains** — either click **+ Add domain** for each domain you
   want, or click **Load domains.yaml** to upload a config file (same format
   the CLI uses — see below) and populate every domain and render parameter
   at once. Per domain, manually or after loading:
   - Give it a name, pick a color, set transparency.
   - Click the **chain chips** to select which chain(s) this domain applies
     to (all chains are selected by default). Click a chip again to
     deselect it. If more than one chain is selected, one envelope is
     generated per chain (e.g. a domain defined once against a 12-chain
     symmetric assembly produces 12 separate, correctly-positioned
     envelopes).
   - Type residue ranges (e.g. `7-274` or `7-45,200-260`), or click the
     suggested range chips pulled from the structure.
   - Expand **Render parameters for this domain** to independently adjust
     sigma / smoothing / decimation / threshold / envelope basis (see below)
     for that one domain — these fields start pre-filled from the current
     global defaults and are freely editable from there.
3. **Tweak render parameters** at the bottom (sigma, smoothing iterations,
   decimation, grid spacing, threshold, envelope basis) — these are the
   starting values new domain rows are pre-filled with.
   - **Envelope basis** controls which atoms the surface is built from:
     backbone trace (default, looks like a cartoon representation), CA trace
     only (chunkier), or all-atom (hugs every side chain). Each falls back
     automatically (backbone → CA → all-atom) if the requested atoms aren't
     present in a given domain (e.g. a ligand with no protein backbone).
4. **Generate envelopes** — click the button. A progress bar tracks how many
   envelopes are done; when finished, they render directly in the 3D viewer
   next to the structure.
5. **Adjust the view** — switch the background (dark / white / transparent),
   hide the original structure, or change the surface style (plastic / matte
   / glossy / metallic / faceted) — all independent of regenerating.
6. **Save a picture** — pick a resolution multiplier (1x–6x) and format
   (PNG / JPEG), then click **Save image** to export exactly what's currently
   in the 3D viewer.
7. **Download results** — click to unfold the Downloads section. Each domain
   gets a viewer-resolution `.obj` plus full high-resolution exports in
   `.obj` / `.stl` / `.ply` / `.glb`. A combined `scene.py` PyMOL script
   (with colors/transparency baked in) is also available — run it with
   `pymol scene.py`.
8. **Save your session** — click **Save state** (top of the sidebar) to
   download a single `.json` file containing the uploaded structure, every
   domain, render parameters, and display settings. Load it back with
   **Load state** any time (even after closing the browser or restarting the
   server) to continue exactly where you left off, with nothing to redefine.
   This is separate from **Load domains.yaml**: a state file is a full
   snapshot including the structure itself, while `domains.yaml` is just the
   domain/parameter config (and is also what the CLI reads).

Because domain definitions are usually set once but render parameters get
tweaked repeatedly, the parameters and Generate button stay pinned at the
bottom of the sidebar so you don't have to scroll back up each time.

## Using the command line (`envelope.py`)

For scripted or batch use, skip the web app and drive the same pipeline
directly from a YAML config:

```bash
python envelope.py 3SOA.pdb domains.yaml -o my_output/
```

`domains.yaml` format:

```yaml
global:
  sigma: 3.5
  smoothing_iterations: 12
  decimate_faces: 4000
  grid_spacing: 1.2
  threshold: auto

domains:
  kinase_domain:
    segid: A
    resid: "7-274"
    color: [0.10, 0.85, 0.85]
    transparency: 0.35
```

Any field omitted per-domain falls back to the `global` block. This produces
per-domain `.obj` files and a combined `scene.py` PyMOL script in the output
directory, same as the web app.

## Project structure

```
envelope_core.py   Shared pipeline (density splatting, Voronoi partitioning,
                    marching cubes, smoothing/decimation, exports).
envelope.py         CLI entry point, built on envelope_core.py.
server.py           FastAPI backend for the web app.
web/                Frontend (HTML/CSS/JS, no build step required).
requirements.txt    Python dependencies.
3SOA.pdb            Example structure.
domains.yaml        Example domain config matching 3SOA.pdb.
```

## Troubleshooting

- **`pip install` fails while compiling a package (scipy / scikit-image /
  MDAnalysis)** — this happens most often with a bare system Python rather
  than conda. Easiest fix: use the Miniconda setup above, which installs
  prebuilt binaries. If you must use system Python: on Ubuntu, install
  `sudo apt install build-essential gfortran libopenblas-dev`; on macOS,
  install Xcode command line tools with `xcode-select --install`; on
  Windows, install the
  ["Desktop development with C++"](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  workload, or just switch to Miniconda.
- **`python` / `conda` not recognized (Windows)** — make sure you're running
  commands from the **Anaconda Prompt**, not the default Command Prompt or
  PowerShell (unless you specifically enabled conda in PowerShell during
  install).
- **Port 8000 already in use** — another process is using it. Either stop
  that process, or edit the last line of `server.py`
  (`uvicorn.run(app, host="127.0.0.1", port=8000)`) to use a different port.
- **Browser shows a blank 3D viewer** — check the browser console for WebGL
  errors; the viewer needs a GPU-accelerated browser context. Try a
  different browser or update your graphics drivers.
- **Mesh decimation is skipped / meshes have more triangles than requested**
  — the optional `fast_simplification` package isn't installed. Run
  `pip install fast_simplification`; everything else still works without it.
- **Uploaded files / generated envelopes pile up over time** — the app
  stores them under `web_data/uploads` and `web_data/runs`. It's safe to
  delete the contents of `web_data/` any time the server isn't running.

## License

MIT — see [LICENSE](LICENSE).
