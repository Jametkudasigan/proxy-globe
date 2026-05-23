#!/usr/bin/env python3
"""Fetch free SOCKS5 proxies from public lists, health-check them,
geolocate IPs, and emit a static proxies.json for the dashboard."""
import json
import socket
import struct
import time
import urllib.request
import urllib.error
import concurrent.futures as cf
import random
import os
import sys
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_FILE = OUT_DIR / "proxies.json"

# Public free SOCKS5 lists — txt format ip:port per line
SOURCES = [
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt",
    "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt",
    "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&proxy_format=ipport&format=text&protocol=socks5",
]

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) ProxyGlobe/1.0"


def fetch_list(url: str) -> set[str]:
    proxies: set[str] = set()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read().decode("utf-8", errors="ignore")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # strip protocol prefix if present
            for prefix in ("socks5://", "socks5h://"):
                if line.startswith(prefix):
                    line = line[len(prefix):]
            # accept ip:port at start of line (some sources include extra columns)
            tok = line.split()[0].split(",")[0]
            if tok.count(":") == 1 and not tok.startswith("/"):
                ip, _, port = tok.partition(":")
                if ip and port.isdigit():
                    proxies.add(f"{ip}:{port}")
        print(f"  fetched {len(proxies):>5} from {url[:70]}")
    except Exception as e:
        print(f"  FAIL {url[:70]} -> {e}")
    return proxies


def collect_proxies() -> list[str]:
    pool: set[str] = set()
    for src in SOURCES:
        pool |= fetch_list(src)
    return sorted(pool)


# ---- SOCKS5 raw connect handshake (no external deps) ----
def socks5_handshake(ip: str, port: int, timeout: float = 4.0) -> tuple[bool, float]:
    """Return (alive, latency_ms). Tests handshake + CONNECT to ipinfo.io:80."""
    start = time.perf_counter()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((ip, port))
        # Greeting: VER=5, NMETHODS=1, METHODS=[0]
        s.sendall(b"\x05\x01\x00")
        resp = s.recv(2)
        if len(resp) < 2 or resp[0] != 0x05 or resp[1] != 0x00:
            s.close()
            return False, 0.0
        # CONNECT request to a stable test host
        # Use IP literal for ifconfig.me cdn
        target_host = "1.1.1.1"
        target_port = 80
        ip_bytes = socket.inet_aton(target_host)
        req = b"\x05\x01\x00\x01" + ip_bytes + struct.pack(">H", target_port)
        s.sendall(req)
        rep = s.recv(10)
        if len(rep) < 2 or rep[1] != 0x00:
            s.close()
            return False, 0.0
        latency = (time.perf_counter() - start) * 1000
        s.close()
        return True, latency
    except Exception:
        return False, 0.0


def health_check(ip_port: str) -> dict | None:
    ip, _, port = ip_port.partition(":")
    if not port.isdigit():
        return None
    alive, latency = socks5_handshake(ip, int(port))
    if not alive:
        # Mark dead but keep entry so dashboard shows red dots too
        return {"ip": ip, "port": int(port), "alive": False, "latency_ms": 0.0}
    if latency > 2500:
        status = "weak"
    elif latency > 1000:
        status = "weak"
    else:
        status = "ok"
    return {"ip": ip, "port": int(port), "alive": True, "latency_ms": round(latency, 1), "status": status}


# ---- Geolocation (batch via ip-api.com) ----
def geolocate(ips: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    # ip-api.com batch endpoint, max 100 per request, 15 req/min limit unprotected
    # Use the free, no-key endpoint
    URL = "http://ip-api.com/batch?fields=status,country,countryCode,city,lat,lon,query"
    for i in range(0, len(ips), 100):
        chunk = ips[i:i + 100]
        body = json.dumps([{"query": ip} for ip in chunk]).encode()
        req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                arr = json.loads(r.read())
            for entry in arr:
                if entry.get("status") == "success":
                    out[entry["query"]] = {
                        "country": entry.get("country", ""),
                        "cc": entry.get("countryCode", ""),
                        "city": entry.get("city", ""),
                        "lat": entry.get("lat", 0.0),
                        "lon": entry.get("lon", 0.0),
                    }
            print(f"  geo batch {i//100 + 1}: +{sum(1 for e in arr if e.get('status')=='success')}")
            time.sleep(4.2)  # respect 15 req/min
        except Exception as e:
            print(f"  geo batch err: {e}")
            time.sleep(8)
    return out


def main(limit: int = 800) -> None:
    print("[1/4] collecting proxy lists...")
    pool = collect_proxies()
    print(f"  pool total: {len(pool)} unique\n")

    if len(pool) > limit:
        # random sample to keep the dashboard fast
        random.seed(int(time.time()))
        pool = random.sample(pool, limit)
        print(f"  sampled {limit} for health-check\n")

    print("[2/4] health-checking (parallel)...")
    results: list[dict] = []
    started = time.time()
    with cf.ThreadPoolExecutor(max_workers=200) as ex:
        for i, r in enumerate(ex.map(health_check, pool), 1):
            if r:
                results.append(r)
            if i % 100 == 0:
                alive_so_far = sum(1 for x in results if x.get("alive"))
                print(f"  {i}/{len(pool)} | alive {alive_so_far} | {time.time()-started:.1f}s")
    alive = [r for r in results if r.get("alive")]
    dead = [r for r in results if not r.get("alive")]
    print(f"  alive: {len(alive)} | dead: {len(dead)}\n")

    print("[3/4] geolocating alive IPs...")
    alive_ips = list({r["ip"] for r in alive})
    geo = geolocate(alive_ips)
    print(f"  geo resolved: {len(geo)}\n")

    # Sample 50 dead too so red dots still appear (geo for them)
    dead_sample_ips: list[str] = []
    if dead:
        dead_sample = random.sample(dead, min(120, len(dead)))
        dead_sample_ips = list({r["ip"] for r in dead_sample})
        if dead_sample_ips:
            print(f"[3b/4] geolocating {len(dead_sample_ips)} dead samples...")
            geo_dead = geolocate(dead_sample_ips)
            geo.update(geo_dead)
            print(f"  geo dead resolved: {len(geo_dead)}\n")
            # Replace dead list with sampled subset for output
            dead_ips_set = set(dead_sample_ips)
            dead = [r for r in dead if r["ip"] in dead_ips_set]

    print("[4/4] composing dataset...")
    proxies_out: list[dict] = []
    for r in alive + dead:
        g = geo.get(r["ip"])
        if not g:
            continue
        latency = r.get("latency_ms", 0.0)
        if not r.get("alive"):
            status = "dead"
        elif latency <= 1000:
            status = "ok"
        else:
            status = "weak"
        proxies_out.append({
            "ip": r["ip"],
            "port": r["port"],
            "alive": r.get("alive", False),
            "latency_ms": latency,
            "status": status,
            "country": g["country"],
            "cc": g["cc"],
            "city": g["city"],
            "lat": g["lat"],
            "lon": g["lon"],
        })

    payload = {
        "generated_at": int(time.time()),
        "total_collected": len(pool),
        "alive": len([p for p in proxies_out if p["status"] != "dead"]),
        "ok": len([p for p in proxies_out if p["status"] == "ok"]),
        "weak": len([p for p in proxies_out if p["status"] == "weak"]),
        "dead": len([p for p in proxies_out if p["status"] == "dead"]),
        "proxies": proxies_out,
    }
    OUT_FILE.write_text(json.dumps(payload, indent=1))
    print(f"\nwrote {OUT_FILE} ({OUT_FILE.stat().st_size} bytes)")
    print(f"summary: ok={payload['ok']} weak={payload['weak']} dead={payload['dead']}")


if __name__ == "__main__":
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 800
    main(limit)
