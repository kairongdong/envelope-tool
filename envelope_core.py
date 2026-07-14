"""
envelope_core.py

Shared pipeline logic for generating smooth "blob" envelope surfaces for
user-defined protein domains from an all-atom structure. Used by both the
envelope.py CLI and the interactive web app (server.py).
"""

import os
import numpy as np
from scipy.spatial import cKDTree
from skimage import measure
import trimesh


# ----------------------------------------------------------------------
# Element -> approximate van der Waals radius (Angstrom), used to weight
# the Gaussian splat width per atom. Falls back to 1.7 (carbon-ish).
# ----------------------------------------------------------------------
VDW_RADII = {
    "H": 1.10, "C": 1.70, "N": 1.55, "O": 1.52, "S": 1.80,
    "P": 1.80, "SE": 1.90, "FE": 1.80, "ZN": 1.39, "MG": 1.73,
    "CA": 2.31, "NA": 2.27, "CL": 1.75, "K": 2.75,
}
DEFAULT_VDW = 1.70

# Average excluded volume per heavy (non-H) atom in a folded protein,
# used only to seed the auto threshold search with a sane starting guess.
AVG_VOLUME_PER_HEAVY_ATOM = 14.0  # Angstrom^3, rough literature estimate

# Average excluded volume per residue in a folded globular protein. Used to
# calibrate target volume when the envelope is built from a sparser
# backbone/CA trace rather than every atom, since atom count alone
# understates the true (all-atom) volume the envelope should enclose.
AVG_VOLUME_PER_RESIDUE = 140.0  # Angstrom^3, rough literature estimate


DEFAULT_BASIS = "backbone"

# Selection language fragment for each basis, and the fallback chain tried
# if the requested basis matches 0 atoms (e.g. "backbone" requested on a
# ligand-only domain falls through to "ca" then "all_atom" rather than
# failing outright).
BASIS_SELECTORS = {"backbone": "backbone", "ca": "name CA", "all_atom": "not name H*"}
BASIS_FALLBACK_CHAIN = {
    "backbone": ["backbone", "ca", "all_atom"],
    "ca": ["ca", "all_atom"],
    "all_atom": ["all_atom"],
}


def load_domain_config(cfg):
    """Fill defaults into a parsed domains-config dict (already loaded from
    YAML or built up from JSON). Returns (domains, global_cfg)."""
    domains = cfg["domains"]
    global_cfg = cfg.get("global", {})
    for name, d in domains.items():
        d.setdefault("segid", None)
        d.setdefault("resid", None)
        d.setdefault("color", [0.5, 0.5, 0.8])
        d.setdefault("transparency", 0.4)
        d.setdefault("sigma", global_cfg.get("sigma", 3.5))
        d.setdefault("smoothing_iterations", global_cfg.get("smoothing_iterations", 10))
        d.setdefault("decimate_faces", global_cfg.get("decimate_faces", 3000))
        d.setdefault("threshold", global_cfg.get("threshold", "auto"))
        d.setdefault("grid_spacing", global_cfg.get("grid_spacing", 1.5))
        d.setdefault("basis", global_cfg.get("basis", DEFAULT_BASIS))
    return domains, global_cfg


def expand_multichain_domains(domains):
    """Expand any domain whose `segid` lists more than one chain into one
    domain per chain (name suffixed with the chain id), each with the same
    color/transparency/parameters. This is what turns a single concise
    entry like `segid: [A, B, C, ...]` into N separate, correctly
    positioned envelopes -- one per chain -- instead of one envelope
    spanning all of them. Domains with a single segid (or none) pass
    through unchanged."""
    expanded = {}
    for name, spec in domains.items():
        segids = spec.get("segid")
        if isinstance(segids, list) and len(segids) > 1:
            for seg in segids:
                sub = dict(spec)
                sub["segid"] = [seg]
                expanded[f"{name}_{seg}"] = sub
        else:
            expanded[name] = spec
    return expanded


def select_atoms(universe, domain_spec):
    """Select atoms for a domain using the requested basis ("backbone",
    "ca", or "all_atom"). If the requested basis matches 0 atoms (e.g.
    "backbone" requested on a ligand domain with no protein backbone),
    falls through to a sparser-first fallback chain rather than failing.

    Returns (atomgroup, mode) where mode is whichever basis actually
    produced atoms -- used by the caller to calibrate the auto threshold.
    """
    sel_parts = []
    if domain_spec.get("segid"):
        segids = domain_spec["segid"]
        if isinstance(segids, str):
            segids = [segids]
        sel_parts.append("segid " + " ".join(segids))
    if domain_spec.get("resid"):
        resid_str = domain_spec["resid"]
        if isinstance(resid_str, str):
            ranges = resid_str.split(",")
        else:
            ranges = resid_str
        resid_sel = " ".join(r.replace("-", ":").strip() for r in ranges)
        sel_parts.append(f"resid {resid_sel}")
    base_query = " and ".join(sel_parts) if sel_parts else "protein"

    basis = domain_spec.get("basis", DEFAULT_BASIS)
    chain = BASIS_FALLBACK_CHAIN.get(basis, BASIS_FALLBACK_CHAIN[DEFAULT_BASIS])
    for mode in chain:
        query = f"{base_query} and {BASIS_SELECTORS[mode]}"
        ag = universe.select_atoms(query)
        if len(ag) > 0:
            return ag, mode

    raise ValueError(f"Domain selection matched 0 atoms: '{base_query}'")


def get_radii(atomgroup):
    elements = atomgroup.elements if hasattr(atomgroup, "elements") and len(atomgroup.elements) else None
    radii = []
    for i, atom in enumerate(atomgroup):
        el = None
        if elements is not None and elements[i]:
            el = elements[i].upper()
        if not el:
            nm = atom.name.strip().upper()
            el = nm[:2] if nm[:2] in VDW_RADII else nm[0]
        radii.append(VDW_RADII.get(el, DEFAULT_VDW))
    return np.array(radii)


def build_global_grid(all_positions, spacing, padding=8.0):
    mins = all_positions.min(axis=0) - padding
    maxs = all_positions.max(axis=0) + padding
    dims = np.ceil((maxs - mins) / spacing).astype(int)
    dims = np.maximum(dims, 4)
    return mins, maxs, dims


def splat_density(positions, radii, sigma, mins, spacing, dims):
    """Gaussian-splat atoms onto a dense 3D grid. Local sub-grid per atom
    for speed (only touches voxels within ~3 sigma of each atom)."""
    grid = np.zeros(dims, dtype=np.float32)
    inv_spacing = 1.0 / spacing
    for pos, r in zip(positions, radii):
        s = sigma * (r / DEFAULT_VDW)
        cutoff = 3.0 * s
        lo = np.floor((pos - mins - cutoff) * inv_spacing).astype(int)
        hi = np.ceil((pos - mins + cutoff) * inv_spacing).astype(int)
        lo = np.clip(lo, 0, np.array(dims) - 1)
        hi = np.clip(hi, 0, np.array(dims) - 1)
        xs = np.arange(lo[0], hi[0] + 1)
        ys = np.arange(lo[1], hi[1] + 1)
        zs = np.arange(lo[2], hi[2] + 1)
        if len(xs) == 0 or len(ys) == 0 or len(zs) == 0:
            continue
        X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
        world_x = mins[0] + X * spacing
        world_y = mins[1] + Y * spacing
        world_z = mins[2] + Z * spacing
        d2 = (world_x - pos[0])**2 + (world_y - pos[1])**2 + (world_z - pos[2])**2
        contribution = np.exp(-d2 / (2 * s * s))
        grid[X, Y, Z] += contribution
    return grid


def voronoi_ownership(all_positions, domain_labels, mins, spacing, dims):
    """For every voxel, find which domain owns it (nearest-atom rule).
    Returns an int array of shape `dims` with domain index per voxel."""
    tree = cKDTree(all_positions)
    xs = mins[0] + np.arange(dims[0]) * spacing
    ys = mins[1] + np.arange(dims[1]) * spacing
    zs = mins[2] + np.arange(dims[2]) * spacing
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
    pts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
    _, nearest_idx = tree.query(pts, k=1, workers=-1)
    owner = domain_labels[nearest_idx].reshape(dims)
    return owner


def mesh_from_density(density, level, spacing, mins):
    verts, faces, normals, values = measure.marching_cubes(density, level=level, spacing=(spacing,) * 3)
    verts = verts + mins
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    return mesh


def auto_calibrate_threshold(density, target_volume, spacing, mins, lo=0.02, hi=None, iters=12):
    """Binary search on isosurface level to match target enclosed volume."""
    if hi is None:
        hi = float(density.max()) * 0.9
    if hi <= lo:
        hi = lo + 0.5
    best_level = (lo + hi) / 2
    for _ in range(iters):
        mid = (lo + hi) / 2
        try:
            mesh = mesh_from_density(density, mid, spacing, mins)
            vol = abs(mesh.volume)
        except Exception:
            vol = 0.0
        if vol == 0.0:
            hi = mid
        elif vol > target_volume:
            lo = mid
        else:
            hi = mid
        best_level = mid
    return best_level


def clean_mesh(mesh, smoothing_iterations, decimate_faces, log=print):
    if smoothing_iterations > 0:
        trimesh.smoothing.filter_taubin(mesh, iterations=smoothing_iterations)
    if decimate_faces and len(mesh.faces) > decimate_faces:
        try:
            mesh = mesh.simplify_quadric_decimation(face_count=decimate_faces)
        except ImportError:
            log("          [note] skipping decimation: install 'fast_simplification' "
                "(pip install fast_simplification) to enable it. Mesh will have more "
                "triangles than requested, but is otherwise correct.")
    mesh.remove_unreferenced_vertices()
    mesh.fix_normals()
    return mesh


def write_pymol_script(pdb_path, domain_outputs, out_dir, script_name="scene.py"):
    """Writes a standalone PyMOL Python script that builds each envelope as a
    native CGO triangle-mesh object."""
    lines = []
    lines.append("# Auto-generated PyMOL scene script.")
    lines.append("# Run with:  pymol " + script_name)
    lines.append("# (or, inside an already-open PyMOL:  run " + script_name + " )")
    lines.append("from pymol import cmd")
    lines.append("from pymol.cgo import BEGIN, TRIANGLES, COLOR, NORMAL, VERTEX, END")
    lines.append("")
    lines.append(f"cmd.load(r'{os.path.abspath(pdb_path)}', 'struct')")
    lines.append("cmd.hide('everything', 'struct')")
    lines.append("cmd.show('cartoon', 'struct')")
    lines.append("cmd.color('grey70', 'struct')")
    lines.append("cmd.bg_color('white')")
    lines.append("cmd.set('ray_opaque_background', 0)")
    lines.append("")

    for d in domain_outputs:
        mesh = d["mesh"]
        verts = mesh.vertices
        faces = mesh.faces
        normals = mesh.vertex_normals
        r, g, b = d["color"]
        name = f"env_{d['name']}"

        cgo_vals = [f"COLOR, {r}, {g}, {b}"]
        for f in faces:
            for vi in f:
                nx, ny, nz = normals[vi]
                vx, vy, vz = verts[vi]
                cgo_vals.append(f"NORMAL, {nx:.4f}, {ny:.4f}, {nz:.4f}")
                cgo_vals.append(f"VERTEX, {vx:.4f}, {vy:.4f}, {vz:.4f}")

        lines.append(f"# --- domain: {d['name']} ({len(faces)} triangles) ---")
        lines.append(f"_{name} = [BEGIN, TRIANGLES,")
        lines.append("    " + ",\n    ".join(cgo_vals))
        lines.append("    , END]")
        lines.append(f"cmd.load_cgo(_{name}, '{name}')")
        lines.append(f"cmd.set('cgo_transparency', {d['transparency']}, '{name}')")
        lines.append(f"cmd.set('two_sided_lighting', 1)")
        lines.append("")

    lines.append("cmd.orient('struct')")
    lines.append("# cmd.ray(1600, 1200)")
    lines.append("# cmd.png('figure.png', dpi=300)")

    script_path = os.path.join(out_dir, script_name)
    with open(script_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return script_path


def run_pipeline(u, domains, global_cfg, pdb_path, out_dir, log=print):
    """Run the full envelope pipeline against an already-loaded MDAnalysis
    Universe `u`. Returns a list of domain_output dicts (name, obj_path,
    color, transparency, mesh)."""
    os.makedirs(out_dir, exist_ok=True)

    log(f"[1/5] Loaded {len(u.atoms)} atoms from {pdb_path}")

    domain_atomgroups = {}
    domain_modes = {}
    for name, spec in domains.items():
        ag, mode = select_atoms(u, spec)
        domain_atomgroups[name] = ag
        domain_modes[name] = mode
        mode_label = {"backbone": "backbone trace", "ca": "CA trace", "all_atom": "all-atom"}[mode]
        log(f"      domain '{name}': {len(ag)} atoms ({mode_label})")

    all_positions = np.vstack([ag.positions for ag in domain_atomgroups.values()])
    domain_names = list(domain_atomgroups.keys())
    domain_index_of_atom = np.concatenate([
        np.full(len(ag), i) for i, ag in enumerate(domain_atomgroups.values())
    ])

    spacing = min(d["grid_spacing"] for d in domains.values())
    mins, maxs, dims = build_global_grid(all_positions, spacing)
    log(f"[2/5] Grid dims {tuple(dims)} at {spacing} A spacing")

    log("[3/5] Computing Voronoi domain ownership per voxel ...")
    owner = voronoi_ownership(all_positions, domain_index_of_atom, mins, spacing, dims)

    domain_outputs = []
    for i, name in enumerate(domain_names):
        spec = domains[name]
        ag = domain_atomgroups[name]
        radii = get_radii(ag)
        log(f"[4/5] Domain '{name}': splatting density (sigma={spec['sigma']} A) ...")
        density = splat_density(ag.positions, radii, spec["sigma"], mins, spacing, dims)

        density_masked = np.where(owner == i, density, 0.0)

        if domain_modes[name] in ("backbone", "ca"):
            n_res = len(set(ag.resids))
            target_volume = n_res * AVG_VOLUME_PER_RESIDUE
        else:
            target_volume = len(ag) * AVG_VOLUME_PER_HEAVY_ATOM
        if spec["threshold"] == "auto":
            level = auto_calibrate_threshold(density_masked, target_volume, spacing, mins)
            log(f"          auto threshold = {level:.4f} (target vol {target_volume:.0f} A^3)")
        else:
            level = float(spec["threshold"])

        mesh = mesh_from_density(density_masked, level, spacing, mins)
        if spec["smoothing_iterations"] > 0:
            trimesh.smoothing.filter_taubin(mesh, iterations=spec["smoothing_iterations"])

        # export a high-resolution (pre-decimation) copy in several formats,
        # before the viewer-oriented mesh below gets decimated down
        highres_mesh = mesh.copy()
        highres_mesh.remove_unreferenced_vertices()
        highres_mesh.fix_normals()
        highres_paths = {}
        for fmt in ("obj", "stl", "ply", "glb"):
            path = os.path.join(out_dir, f"{name}_highres.{fmt}")
            highres_mesh.export(path)
            highres_paths[fmt] = path
        log(f"          high-res export: {len(highres_mesh.vertices)} verts, "
            f"{len(highres_mesh.faces)} faces -> {name}_highres.{{obj,stl,ply,glb}}")

        mesh = clean_mesh(mesh, 0, spec["decimate_faces"], log=log)

        obj_path = os.path.join(out_dir, f"{name}_envelope.obj")
        mesh.export(obj_path)
        log(f"          -> {obj_path}  ({len(mesh.vertices)} verts, {len(mesh.faces)} faces, "
            f"vol={abs(mesh.volume):.0f} A^3)")

        domain_outputs.append({
            "name": name,
            "obj_path": obj_path,
            "highres_paths": highres_paths,
            "color": spec["color"],
            "transparency": spec["transparency"],
            "mesh": mesh,
        })

    log("[5/5] Writing combined PyMOL scene script ...")
    script_path = write_pymol_script(pdb_path, domain_outputs, out_dir)
    log(f"      -> {script_path}")

    return domain_outputs, script_path
