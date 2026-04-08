#!/usr/bin/env python3
"""
UrhoX Project Restorer

Download build artifacts from CDN and restore them into an editable project structure.
This is the reverse operation of project_builder.py.

Usage:
    # Download using game_url (project_id defaults to {original}_copy)
    python project_restorer.py --game-url https://<uuid>.games.tapapps.cn

    # Download using maker share URL (auto-converted, headers added automatically)
    python project_restorer.py -u https://maker.taptap.cn/shares/<share_id>

    # Download using portal URL (auto-converted to game_url)
    python project_restorer.py -u https://maker.taptap.cn/app/<uuid>

    # Download using TapTap link (resolved via lookup API)
    python project_restorer.py -u https://www.taptap.cn/app/805630

    # Download using app_id (resolved via lookup API)
    python project_restorer.py --app-id 805630

    # Download using game title (resolved via lookup API)
    python project_restorer.py --title 豆战异世界

    # Download using project ID (shorthand)
    python project_restorer.py --project p_xxx --output ./restored_project

    # Specify version
    python project_restorer.py --project p_xxx --version 1.2.3 --output ./restored_project

    # Custom CDN and concurrency
    python project_restorer.py --project p_xxx --base-url https://custom-cdn.com/src --threads 8
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple


BASE_URL = "https://tapcode-sce.spark.xd.com/src"
LOOKUP_API_URL = "https://publisher-pd.spark.xd.com/api/map/get-game-url"
DEFAULT_THREADS = 4
DEFAULT_PLATFORM = "windows"


# ---------------------------------------------------------------------------
# Network helpers (same patterns as resource_query.py)
# ---------------------------------------------------------------------------

def fetch_json(url: str, timeout: int = 15,
               headers: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """Fetch JSON from URL."""
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  HTTP Error {e.code}: {url}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"  URL Error: {e.reason}", file=sys.stderr)
        return None
    except json.JSONDecodeError as e:
        print(f"  JSON Error: {e}", file=sys.stderr)
        return None


def download_bytes(url: str, timeout: int = 60,
                   headers: Optional[Dict[str, str]] = None) -> Optional[bytes]:
    """Download raw bytes from URL."""
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except Exception as e:
        print(f"  Download Error: {e} ({url})", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# game_url helpers
# ---------------------------------------------------------------------------

def ensure_trailing_slash(url: str) -> str:
    """Ensure URL ends with /."""
    return url if url.endswith("/") else url + "/"


# Pattern: https://maker.taptap.cn/app/<uuid>?chatId=...
# Pattern: https://fuping.agnt.xd.com/app/<uuid>?chatId=...
_PORTAL_APP_RE = re.compile(r"/app/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE)

# Pattern: https://maker.taptap.cn/shares/<share_id>
_SHARE_RE = re.compile(r"/shares/([A-Za-z0-9_-]+)")

# Pattern: https://s-<share_id>.games.tapapps.cn/
_SHARE_GAME_URL_RE = re.compile(r"https://s-([A-Za-z0-9_-]+)\.games\.tapapps\.cn")


def parse_portal_url(url: str) -> Optional[str]:
    """Convert portal/admin URLs to game_url.

    Supported patterns:
      maker.taptap.cn/app/<uuid>     -> https://<uuid>.games.tapapps.cn/
      maker.taptap.cn/shares/<id>    -> https://s-<id>.games.tapapps.cn/
      fuping.agnt.xd.com/app/<uuid>  -> https://<uuid>.ipv.taptap-code.org/
    Returns None if the URL is not a recognized portal URL.
    """
    # Check share URL first (maker.taptap.cn/shares/<share_id>)
    m = _SHARE_RE.search(url)
    if m and "maker.taptap.cn" in url:
        share_id = m.group(1)
        return f"https://s-{share_id}.games.tapapps.cn/"

    m = _PORTAL_APP_RE.search(url)
    if not m:
        return None
    pod_id = m.group(1)

    if "maker.taptap.cn" in url:
        return f"https://{pod_id}.games.tapapps.cn/"
    if ".agnt.xd.com" in url:
        return f"https://{pod_id}.ipv.taptap-code.org/"
    return None


def get_share_headers(game_url: str) -> Dict[str, str]:
    """Return required request headers for share-based game URLs.

    Share URLs (s-*.games.tapapps.cn) require Referer and sec-fetch-dest
    headers for nginx to route requests to the static file server.
    """
    if _SHARE_GAME_URL_RE.match(game_url):
        origin = game_url.rstrip("/") + "/"
        return {
            "Referer": origin,
            "sec-fetch-dest": "empty",
        }
    return {}


def detect_taptap_link(url: str) -> Optional[str]:
    """Extract app_id from a TapTap link.

    Matches patterns like https://www.taptap.cn/app/805630
    Returns the numeric app_id string, or None if not a TapTap link.
    """
    m = re.search(r"www\.taptap\.cn/app/(\d+)", url)
    return m.group(1) if m else None


def lookup_game_url(params: Dict[str, str], verbose: bool = False) -> Optional[Dict[str, Any]]:
    """Resolve game_url via the publisher lookup API.

    params: one of {"tap_link": ...}, {"app_id": ...}, {"title": ...}, {"project_id": ...}
    Returns data dict with project_id, app_id, title, game_url, game_version on success.
    """
    query = urllib.parse.urlencode(params)
    url = f"{LOOKUP_API_URL}?{query}"
    if verbose:
        print(f"  Lookup API: {url}")
    data = fetch_json(url)
    if data is None:
        print("ERROR: Lookup API request failed.", file=sys.stderr)
        return None
    if not data.get("result"):
        print(f"ERROR: Lookup API: {data.get('error', 'unknown error')}", file=sys.stderr)
        return None
    return data.get("data")


def game_url_from_project(base_url: str, project: str) -> str:
    """Build game_url from base_url and project ID."""
    return ensure_trailing_slash(f"{base_url}/{project}")


def resolve_project_id(game_url: str, verbose: bool = False,
                       headers: Optional[Dict[str, str]] = None) -> Optional[str]:
    """Resolve project_id from game_url by fetching project.json."""
    url = f"{game_url}project.json"
    if verbose:
        print(f"  Fetching project.json from {url} ...")
    data = fetch_json(url, headers=headers)
    if data:
        return data.get("project_id") or data.get("id")
    return None


# ---------------------------------------------------------------------------
# Version / manifest helpers
# ---------------------------------------------------------------------------

def get_version_info(game_url: str, tag: str,
                     headers: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """Get version info from tag (latest/stable) or version number."""
    if "." in tag:
        url = f"{game_url}{tag}/version.json"
    else:
        url = f"{game_url}{tag}.json"
    return fetch_json(url, headers=headers)


def get_manifest(game_url: str, version: str, manifest_hash: str,
                 headers: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """Get manifest by version and hash."""
    url = f"{game_url}{version}/manifest-{manifest_hash}.json"
    return fetch_json(url, headers=headers)


# ---------------------------------------------------------------------------
# File entry helpers
# ---------------------------------------------------------------------------

def get_hash_for_platform(file_entry: Dict[str, Any], platform: str = DEFAULT_PLATFORM) -> str:
    """Get hash for the specified platform, falling back to default hash."""
    return file_entry.get(f"hash@{platform}") or file_entry.get("hash", "")


def get_size_for_platform(file_entry: Dict[str, Any], platform: str = DEFAULT_PLATFORM) -> int:
    """Get size for the specified platform, falling back to default size."""
    return file_entry.get(f"size@{platform}") or file_entry.get("size", 0)


def get_resource_url(game_url: str, uuid: str, hash_val: str, ext: str) -> str:
    """Build resource download URL."""
    return f"{game_url}assets/{uuid}-{hash_val}{ext}"


def is_local_resource(file_entry: Dict[str, Any]) -> bool:
    """Check if a file is a local project resource (not from engine-res, official-res, etc.)."""
    source = file_entry.get("source", "")
    return source == "" or source == "project"


def get_asset_prefixes(client_manifest: Optional[Dict[str, Any]]) -> List[str]:
    """Extract asset_prefixes from manifest (top-level field), defaulting to ["assets", "scripts"]."""
    if client_manifest:
        prefixes = client_manifest.get("asset_prefixes", [])
        if prefixes:
            return prefixes
    return ["assets", "scripts"]


# ---------------------------------------------------------------------------
# Merge manifests
# ---------------------------------------------------------------------------

def merge_manifest_files(client_manifest: Optional[Dict[str, Any]],
                         server_manifest: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge files from client and server manifests, dedup by uuid."""
    seen = {}
    for manifest in (client_manifest, server_manifest):
        if manifest is None:
            continue
        for f in manifest.get("files", []):
            uuid = f.get("uuid", "")
            if uuid and uuid not in seen:
                seen[uuid] = f
    return list(seen.values())


# ---------------------------------------------------------------------------
# Download worker
# ---------------------------------------------------------------------------

def download_one_file(game_url: str, file_entry: Dict[str, Any],
                      output_dir: Path, platform: str, verbose: bool,
                      headers: Optional[Dict[str, str]] = None) -> Tuple[bool, str, int]:
    """Download a single file and write it + its .meta to the output directory.

    Returns (success, fs_path, bytes_written).
    """
    uuid = file_entry.get("uuid", "")
    ext = file_entry.get("ext", "")
    fs_path = file_entry.get("fs_path", "")
    hash_val = get_hash_for_platform(file_entry, platform)

    if not uuid or not hash_val:
        return False, fs_path, 0

    # .lua -> scripts/, everything else -> assets/
    prefix = "scripts" if ext == ".lua" else "assets"
    local_path = output_dir / prefix / fs_path if fs_path else output_dir / prefix / f"{uuid}{ext}"

    # Build URL and download
    url = get_resource_url(game_url, uuid, hash_val, ext)
    data = download_bytes(url, headers=headers)
    if data is None:
        return False, fs_path or f"{uuid}{ext}", 0

    # Write file
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(data)

    # Write .meta file (uuid + groups from manifest)
    meta_data = {"uuid": uuid}
    groups = file_entry.get("groups", [])
    if groups:
        meta_data["group"] = groups[0] if len(groups) == 1 else groups
    meta_path = local_path.parent / (local_path.name + ".meta")
    meta_path.write_text(json.dumps(meta_data, indent=2) + "\n", encoding="utf-8")

    if verbose:
        print(f"  {prefix}/{fs_path}  ({len(data):,} bytes)")

    return True, fs_path or f"{uuid}{ext}", len(data)


# ---------------------------------------------------------------------------
# .project/ generation
# ---------------------------------------------------------------------------

def generate_project_json(output_dir: Path, project_id: str, version: str,
                          version_info: Dict[str, Any],
                          client_manifest: Optional[Dict[str, Any]],
                          server_manifest: Optional[Dict[str, Any]]):
    """Generate .project/project.json."""
    # entry is a top-level manifest field
    client_entry = None
    server_entry = None
    if client_manifest:
        client_entry = client_manifest.get("entry")
    if server_manifest:
        server_entry = server_manifest.get("entry")

    effective_id = project_id + "_copy"

    data = {
        "project_id": effective_id,
        "name": effective_id,
        "description": f"Restored from {version}",
        "author": {
            "id": "",
            "name": ""
        },
        "version": version,
    }

    # Networked game: client and server have different entries
    if client_entry and server_entry and client_entry != server_entry:
        data["entry"] = "main.lua"
        data["entry@client"] = client_entry
        data["entry@server"] = server_entry
    else:
        data["entry"] = client_entry or server_entry or "main.lua"

    path = output_dir / ".project" / "project.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def generate_resources_json(output_dir: Path,
                            client_manifest: Optional[Dict[str, Any]]):
    """Generate .project/resources.json.

    Only restore preload_groups here. Per-file group assignments are stored
    in each file's .meta (the "group" field), which the builder reads directly.
    """
    preload_groups = ["default"]

    if client_manifest:
        preload_groups = client_manifest.get("preload_groups", preload_groups)

    data = {
        "preload_groups": preload_groups,
    }

    path = output_dir / ".project" / "resources.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def generate_settings_json(output_dir: Path,
                           client_manifest: Optional[Dict[str, Any]],
                           version_info: Dict[str, Any]):
    """Generate .project/settings.json."""
    # Build sources from manifest
    sources = {}
    if client_manifest:
        manifest_sources = client_manifest.get("sources", {})
        for name, info in manifest_sources.items():
            sources[name] = {"tag": info.get("tag", "latest")}
            if "base_url" in info:
                sources[name]["base_url"] = info["base_url"]

    # engine tag follows engine-res tag
    if "engine" in version_info and "engine" not in sources:
        engine_res_tag = sources.get("engine-res", {}).get("tag", "latest")
        sources["engine"] = {"tag": engine_res_tag}

    # Derive asset_dirs from manifest's asset_prefixes
    prefixes = get_asset_prefixes(client_manifest)
    asset_dirs = [f"../{p}" for p in prefixes]

    data = {
        "sources": sources,
        "build": {
            "generate_fs_path": True,
            "output_dir": "../dist",
            "asset_dirs": asset_dirs,
            "asset_ignores": [],
        },
    }

    path = output_dir / ".project" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def generate_restore_info(output_dir: Path, project_id: str, version: str, tag: str,
                          game_url: str, client_hash: str, server_hash: str,
                          platform: str, total_files: int, total_size: int,
                          source_url: str = "", maker_project_id: str = ""):
    """Generate .restore_info.json with provenance metadata."""
    effective_id = project_id + "_copy"

    data = {
        "restored_at": datetime.now(timezone.utc).isoformat(),
        "project_id": effective_id,
        "original_project_id": project_id,
        "version": version,
        "tag": tag,
        "source_url": source_url,
        "game_url": game_url,
        "client_manifest_hash": client_hash,
        "server_manifest_hash": server_hash,
        "total_files": total_files,
        "total_size": total_size,
        "platform": platform,
    }
    if maker_project_id:
        data["maker_project_id"] = maker_project_id

    path = output_dir / ".restore_info.json"
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Main restore logic
# ---------------------------------------------------------------------------

def restore_project(game_url: str, project_id: Optional[str], tag: str,
                    output_dir: Optional[Path], threads: int, platform: str,
                    verbose: bool, source_url: str = "",
                    maker_project_id: str = "") -> int:
    """Main restore flow. Returns exit code."""

    game_url = ensure_trailing_slash(game_url)

    # Compute required headers for share-based game URLs (s-*.games.tapapps.cn)
    headers = get_share_headers(game_url) or None
    if headers:
        print(f"  Share URL detected, adding required headers: {list(headers.keys())}")

    # ---- Step 0: resolve project_id if not provided ----
    if not project_id:
        print(f"[0/6] Resolving project_id from {game_url} ...")
        project_id = resolve_project_id(game_url, verbose, headers=headers)
        if not project_id:
            print("ERROR: Could not resolve project_id from game_url. "
                  "Tried fetching project.json.", file=sys.stderr)
            return 1
        print(f"  Resolved project_id: {project_id}")

    effective_id = project_id + "_copy"

    # ---- Step 1: version.json ----
    print(f"[1/6] Fetching version info for '{project_id}' tag='{tag}' ...")
    version_info = get_version_info(game_url, tag, headers=headers)
    if not version_info:
        print("ERROR: Failed to fetch version info.", file=sys.stderr)
        return 1

    version = version_info.get("version", "")
    client_hash = version_info.get("client", "")
    server_hash = version_info.get("server", "")

    print(f"  Version : {version}")
    print(f"  Client  : {client_hash}")
    print(f"  Server  : {server_hash}")

    if not version:
        print("ERROR: version.json missing 'version' field.", file=sys.stderr)
        return 1

    # Determine restore directory (after version is resolved)
    if output_dir is None:
        output_dir = Path(f"./tmp/restored_projects/{project_id}@{version}")

    # ---- Step 2: manifests ----
    print(f"[2/6] Downloading manifests ...")

    client_manifest = None
    server_manifest = None

    if client_hash:
        client_manifest = get_manifest(game_url, version, client_hash, headers=headers)
        if client_manifest:
            print(f"  Client manifest: {len(client_manifest.get('files', []))} files")
        else:
            print("  WARNING: Failed to fetch client manifest.", file=sys.stderr)

    if server_hash:
        server_manifest = get_manifest(game_url, version, server_hash, headers=headers)
        if server_manifest:
            print(f"  Server manifest: {len(server_manifest.get('files', []))} files")
        else:
            print("  WARNING: Failed to fetch server manifest.", file=sys.stderr)

    if client_manifest is None and server_manifest is None:
        print("ERROR: Could not fetch any manifest.", file=sys.stderr)
        return 1

    # ---- Step 3: merge & filter ----
    print(f"[3/6] Merging and filtering files ...")
    all_files = merge_manifest_files(client_manifest, server_manifest)
    print(f"  Total unique files: {len(all_files)}")

    local_files = [f for f in all_files if is_local_resource(f)]
    skipped_remote = len(all_files) - len(local_files)
    print(f"  Local project files: {len(local_files)}")
    print(f"  Skipped remote files: {skipped_remote}")

    if not local_files:
        print("WARNING: No local project files found. The project may only contain remote resources.")

    # ---- Step 4: prepare output directory ----
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"[4/6] Output directory: {output_dir.resolve()}")

    # ---- Step 5: download files ----
    print(f"[5/6] Downloading {len(local_files)} files (threads={threads}, platform={platform}) ...")
    t0 = time.monotonic()
    success_count = 0
    fail_count = 0
    total_size = 0

    with ThreadPoolExecutor(max_workers=threads) as executor:
        futures = {
            executor.submit(
                download_one_file, game_url, f, output_dir, platform, verbose,
                headers=headers,
            ): f
            for f in local_files
        }

        for future in as_completed(futures):
            ok, path, size = future.result()
            if ok:
                success_count += 1
                total_size += size
            else:
                fail_count += 1
                if not verbose:
                    print(f"  FAILED: {path}", file=sys.stderr)

    elapsed = time.monotonic() - t0
    print(f"  Downloaded {success_count} files ({total_size:,} bytes) in {elapsed:.1f}s")
    if fail_count:
        print(f"  Failed: {fail_count} files", file=sys.stderr)

    # ---- Step 6: generate .project/ config ----
    print(f"[6/6] Generating .project/ configuration ...")
    generate_project_json(output_dir, project_id, version, version_info, client_manifest, server_manifest)
    generate_resources_json(output_dir, client_manifest)
    generate_settings_json(output_dir, client_manifest, version_info)
    generate_restore_info(
        output_dir, project_id, version, tag, game_url,
        client_hash, server_hash, platform,
        success_count, total_size,
        source_url=source_url,
        maker_project_id=maker_project_id,
    )
    print("  Generated: project.json, resources.json, settings.json, .restore_info.json")

    # ---- Summary ----
    print()
    print("=" * 60)
    print(f"  Project restored successfully!")
    print(f"  Project ID : {effective_id}")
    print(f"  Original   : {project_id}")
    print(f"  Game URL   : {game_url}")
    print(f"  Location   : {output_dir.resolve()}")
    print(f"  Files      : {success_count}")
    print(f"  Size       : {total_size:,} bytes")
    if fail_count:
        print(f"  Failures   : {fail_count}")
    print("=" * 60)

    return 1 if fail_count else 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="UrhoX Project Restorer - Restore editable project from CDN build artifacts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Primary: restore from game_url (project_id defaults to {original}_copy)
  %(prog)s --game-url https://<uuid>.games.tapapps.cn
  %(prog)s -u https://<uuid>.ipv.taptap-code.org -v

  # Maker share URL (auto-converted, required headers added automatically)
  %(prog)s -u https://maker.taptap.cn/shares/<share_id>

  # Portal/admin URLs (auto-converted to game_url)
  %(prog)s -u https://maker.taptap.cn/app/<uuid>
  %(prog)s -u https://fuping.agnt.xd.com/app/<uuid>

  # TapTap link (resolved via lookup API)
  %(prog)s -u https://www.taptap.cn/app/805630

  # App ID (resolved via lookup API)
  %(prog)s --app-id 805630

  # Game title (resolved via lookup API)
  %(prog)s --title 豆战异世界

  # Shorthand: restore from project ID
  %(prog)s --project p_xxx --output ./restored
  %(prog)s --project p_xxx --version 1.2.3

  # Custom CDN
  %(prog)s --project p_xxx --base-url https://custom-cdn.com/src --threads 8
        """,
    )

    parser.add_argument(
        "-u", "--game-url",
        default=None,
        help="Game URL or portal URL. Accepts: direct game_url (https://<uuid>.games.tapapps.cn), "
             "maker share (https://maker.taptap.cn/shares/<share_id>), "
             "maker portal (https://maker.taptap.cn/app/<uuid>), "
             "fuping (https://fuping.agnt.xd.com/app/<uuid>). "
             "Portal/share URLs are auto-converted to game_url. Takes priority over --project.",
    )
    parser.add_argument(
        "-p", "--project",
        default=None,
        help="Project ID (e.g., p_xxx). Used as shorthand to construct game_url from CDN base.",
    )
    parser.add_argument(
        "--app-id",
        default=None,
        help="TapTap app ID (numeric). Resolves game_url via lookup API.",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="Game title (e.g., 豆战异世界). Resolves game_url via lookup API.",
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        help="Output directory (default: ./tmp/restored_projects/<project_id>@<version>)",
    )
    parser.add_argument(
        "-V", "--version",
        default="latest",
        dest="version",
        help="Version or tag: 1.2.3, latest, stable (default: latest)",
    )
    parser.add_argument(
        "--base-url",
        default=BASE_URL,
        help=f"CDN base URL, used when --project is given (default: {BASE_URL})",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=DEFAULT_THREADS,
        help=f"Number of concurrent download threads (default: {DEFAULT_THREADS})",
    )
    parser.add_argument(
        "--platform",
        default=DEFAULT_PLATFORM,
        help=f"Platform for hash selection (default: {DEFAULT_PLATFORM})",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Print each downloaded file",
    )

    args = parser.parse_args()

    # Resolve game_url
    # source_url: the raw input from user (before any conversion)
    source_url = args.game_url or args.app_id or args.title or args.project or ""
    game_url = None
    project_id = None
    maker_project_id = ""

    if args.app_id:
        # --app-id: resolve via lookup API
        print(f"  Looking up app_id={args.app_id} ...")
        lookup_data = lookup_game_url({"app_id": args.app_id}, verbose=args.verbose)
        if not lookup_data or not lookup_data.get("game_url"):
            print("ERROR: Could not resolve game_url from app_id.", file=sys.stderr)
            return 1
        game_url = ensure_trailing_slash(lookup_data["game_url"])
        project_id = lookup_data.get("project_id")
        maker_project_id = lookup_data.get("maker_project_id", "")
        print(f"  Resolved: {lookup_data.get('title', '')} -> {game_url}")

    elif args.title:
        # --title: resolve via lookup API
        print(f"  Looking up title=\"{args.title}\" ...")
        lookup_data = lookup_game_url({"title": args.title}, verbose=args.verbose)
        if not lookup_data or not lookup_data.get("game_url"):
            print("ERROR: Could not resolve game_url from title.", file=sys.stderr)
            return 1
        game_url = ensure_trailing_slash(lookup_data["game_url"])
        project_id = lookup_data.get("project_id")
        maker_project_id = lookup_data.get("maker_project_id", "")
        print(f"  Resolved: {lookup_data.get('title', '')} -> {game_url}")

    elif args.game_url:
        # Check if the URL is a TapTap link that needs API lookup
        taptap_app_id = detect_taptap_link(args.game_url)
        if taptap_app_id:
            print(f"  TapTap link detected, looking up app_id={taptap_app_id} ...")
            lookup_data = lookup_game_url({"tap_link": args.game_url}, verbose=args.verbose)
            if not lookup_data or not lookup_data.get("game_url"):
                print("ERROR: Could not resolve game_url from TapTap link.", file=sys.stderr)
                return 1
            game_url = ensure_trailing_slash(lookup_data["game_url"])
            project_id = lookup_data.get("project_id")
            maker_project_id = lookup_data.get("maker_project_id", "")
            print(f"  Resolved: {lookup_data.get('title', '')} -> {game_url}")
        else:
            # Check if the URL is a portal/admin URL that needs conversion
            portal_game_url = parse_portal_url(args.game_url)
            if portal_game_url:
                print(f"  Converted portal URL -> {portal_game_url}")
                game_url = portal_game_url
                # Portal URL contains the pod UUID (maker_project_id)
                m = _PORTAL_APP_RE.search(args.game_url)
                if m:
                    maker_project_id = m.group(1)
            else:
                game_url = ensure_trailing_slash(args.game_url)
            # project_id will be resolved from game_url later if needed
            project_id = args.project  # may be None

    elif args.project:
        # --project: try API lookup first, fallback to CDN URL construction
        print(f"  Looking up project_id={args.project} ...")
        lookup_data = lookup_game_url({"project_id": args.project}, verbose=args.verbose)
        if lookup_data and lookup_data.get("game_url"):
            game_url = ensure_trailing_slash(lookup_data["game_url"])
            project_id = lookup_data.get("project_id", args.project)
            maker_project_id = lookup_data.get("maker_project_id", "")
            print(f"  Resolved: {lookup_data.get('title', '')} -> {game_url}")
        else:
            print(f"  API lookup failed, falling back to CDN URL construction.")
            game_url = game_url_from_project(args.base_url, args.project)
            project_id = args.project

    else:
        parser.error("One of --game-url, --project, --app-id, or --title is required.")

    output_dir = Path(args.output) if args.output else None

    return restore_project(
        game_url=game_url,
        project_id=project_id,
        tag=args.version,
        output_dir=output_dir,
        threads=args.threads,
        platform=args.platform,
        verbose=args.verbose,
        source_url=source_url,
        maker_project_id=maker_project_id,
    )


if __name__ == "__main__":
    sys.exit(main())
