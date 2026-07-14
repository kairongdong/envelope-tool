#!/usr/bin/env python3
"""
server.py

Local web app for interactively generating domain envelopes:
  - upload a PDB
  - pick segids/residue ranges (parsed from the structure) per domain
  - set colors, transparency, and smoothing/decimation parameters
  - generate envelope meshes and view them in-browser next to the cartoon
  - download the .obj files and the combined PyMOL scene.py

Run with:
  python server.py
Then open http://127.0.0.1:8000
"""

import os
import time
import uuid
import shutil
import threading

import yaml
import numpy as np
import MDAnalysis as mda
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from typing import List, Optional, Union

from envelope_core import load_domain_config, expand_multichain_domains, run_pipeline

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "web_data", "uploads")
RUNS_DIR = os.path.join(BASE_DIR, "web_data", "runs")
WEB_DIR = os.path.join(BASE_DIR, "web")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RUNS_DIR, exist_ok=True)

app = FastAPI(title="Envelope Tool")


@app.middleware("http")
async def no_cache(request, call_next):
    """This is a local dev tool whose frontend files change often; a stale
    cached copy of app.js/style.css silently running old code is a much
    worse failure mode than the browser re-fetching every time."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


# in-memory session registry: session_id -> pdb_path
SESSIONS = {}

# in-memory job registry: job_id -> {status, log, result, error, total_domains, started_at}
JOBS = {}
JOBS_LOCK = threading.Lock()


def contiguous_ranges(resids):
    resids = sorted(set(int(r) for r in resids))
    if not resids:
        return []
    ranges = []
    start = prev = resids[0]
    for r in resids[1:]:
        if r == prev + 1:
            prev = r
        else:
            ranges.append([start, prev])
            start = prev = r
    ranges.append([start, prev])
    return ranges


@app.post("/api/upload")
async def upload_pdb(pdb: UploadFile = File(...)):
    session_id = uuid.uuid4().hex[:12]
    dest_path = os.path.join(UPLOAD_DIR, f"{session_id}.pdb")
    with open(dest_path, "wb") as f:
        shutil.copyfileobj(pdb.file, f)

    try:
        u = mda.Universe(dest_path)
    except Exception as e:
        os.remove(dest_path)
        raise HTTPException(status_code=400, detail=f"Could not parse PDB: {e}")

    SESSIONS[session_id] = dest_path

    segids = sorted(set(u.atoms.segids)) if hasattr(u.atoms, "segids") else []
    seg_info = {}
    for seg in segids:
        ag = u.select_atoms(f"segid {seg}")
        seg_info[seg] = {
            "n_atoms": len(ag),
            "ranges": contiguous_ranges(ag.resids),
            "resnames": sorted(set(ag.resnames)),
        }

    return {
        "session_id": session_id,
        "filename": pdb.filename,
        "n_atoms": len(u.atoms),
        "segids": seg_info,
    }


@app.post("/api/parse-domains-yaml")
async def parse_domains_yaml(config: UploadFile = File(...)):
    """Parse an uploaded domains.yaml (same format the CLI takes) and return
    it fully resolved (every domain filled in with its effective sigma/
    smoothing/decimate/threshold/basis/etc.) so the frontend can populate
    the form directly instead of re-implementing the default-fill logic."""
    try:
        content = await config.read()
        cfg = yaml.safe_load(content)
        if not isinstance(cfg, dict) or "domains" not in cfg:
            raise ValueError("YAML must have a top-level 'domains' key")
        domains, global_cfg = load_domain_config(cfg)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse domains YAML: {e}")

    resolved_global = {
        "sigma": global_cfg.get("sigma", 3.5),
        "smoothing_iterations": global_cfg.get("smoothing_iterations", 10),
        "decimate_faces": global_cfg.get("decimate_faces", 3000),
        "grid_spacing": global_cfg.get("grid_spacing", 1.5),
        "threshold": global_cfg.get("threshold", "auto"),
        "basis": global_cfg.get("basis", "backbone"),
    }

    return {"global": resolved_global, "domains": domains}


class DomainSpec(BaseModel):
    name: str
    segid: Union[str, List[str], None] = None
    resid: Union[str, List[str], None] = None
    color: List[float] = Field(default_factory=lambda: [0.5, 0.5, 0.8])
    transparency: float = 0.4
    sigma: Optional[float] = None
    smoothing_iterations: Optional[int] = None
    decimate_faces: Optional[int] = None
    threshold: Optional[Union[str, float]] = None
    grid_spacing: Optional[float] = None
    basis: Optional[str] = None


class GlobalSpec(BaseModel):
    sigma: float = 3.5
    smoothing_iterations: int = 10
    decimate_faces: int = 3000
    grid_spacing: float = 1.5
    threshold: Union[str, float] = "auto"
    basis: str = "backbone"


class GenerateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: str
    global_: GlobalSpec = Field(default_factory=GlobalSpec, alias="global")
    domains: List[DomainSpec]


def _run_job(job_id, pdb_path, domains, global_cfg_filled, out_dir, run_id):
    def log(msg):
        with JOBS_LOCK:
            JOBS[job_id]["log"].append(msg)

    try:
        u = mda.Universe(pdb_path)
        domain_outputs, script_path = run_pipeline(u, domains, global_cfg_filled, pdb_path, out_dir, log=log)

        result_domains = []
        for d in domain_outputs:
            mesh = d["mesh"]
            result_domains.append({
                "name": d["name"],
                "color": d["color"],
                "transparency": d["transparency"],
                "vertices": mesh.vertices.astype(np.float32).flatten().tolist(),
                "faces": mesh.faces.astype(np.int32).flatten().tolist(),
                "normals": mesh.vertex_normals.astype(np.float32).flatten().tolist(),
                "n_verts": len(mesh.vertices),
                "n_faces": len(mesh.faces),
                "volume": abs(float(mesh.volume)),
                "obj_url": f"/api/runs/{run_id}/{d['name']}_envelope.obj",
                "highres_urls": {
                    fmt: f"/api/runs/{run_id}/{d['name']}_highres.{fmt}"
                    for fmt in ("obj", "stl", "ply", "glb")
                },
            })

        result = {
            "run_id": run_id,
            "domains": result_domains,
            "scene_py_url": f"/api/runs/{run_id}/scene.py",
        }
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "done"
            JOBS[job_id]["result"] = result
    except Exception as e:
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["error"] = str(e)


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    pdb_path = SESSIONS.get(req.session_id)
    if not pdb_path or not os.path.exists(pdb_path):
        raise HTTPException(status_code=404, detail="Unknown or expired session_id; re-upload the PDB.")

    if not req.domains:
        raise HTTPException(status_code=400, detail="Define at least one domain.")

    global_cfg = req.global_.model_dump()
    domains_cfg = {}
    for d in req.domains:
        spec = d.model_dump(exclude={"name"}, exclude_none=True)
        domains_cfg[d.name] = spec

    cfg = {"global": global_cfg, "domains": domains_cfg}
    try:
        domains, global_cfg_filled = load_domain_config(cfg)
        domains = expand_multichain_domains(domains)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    run_id = uuid.uuid4().hex[:12]
    out_dir = os.path.join(RUNS_DIR, run_id)
    job_id = uuid.uuid4().hex[:12]

    JOBS[job_id] = {
        "status": "running",
        "log": [],
        "result": None,
        "error": None,
        "total_domains": len(domains),
        "started_at": time.time(),
    }

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, pdb_path, domains, global_cfg_filled, out_dir, run_id),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "total_domains": len(domains)}


@app.get("/api/generate/{job_id}")
async def generate_status(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Unknown job_id.")
        return {
            "status": job["status"],
            "log": list(job["log"]),
            "result": job["result"],
            "error": job["error"],
            "total_domains": job["total_domains"],
            "elapsed": time.time() - job["started_at"],
        }


app.mount("/api/runs", StaticFiles(directory=RUNS_DIR), name="runs")
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
