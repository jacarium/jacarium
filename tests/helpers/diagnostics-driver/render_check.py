#!/usr/bin/env python3
"""Render the two cgroups templates with SYNTHETIC data and dump the HTML
into /tmp/diag-scratch/, so extract_check.mjs can node --check the script
blocks (raw Jinja is not valid JS on its own). Run with the backend venv:
  backend/venv/bin/python3 tests/helpers/diagnostics-driver/render_check.py

All values are made up (example-daemon, proc-N pids, round numbers) - no data
from any real system or report is embedded here.
"""
import json, os, sys
from jinja2 import Environment, FileSystemLoader

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "backend", "templates")
OUT = "/tmp/diag-scratch"
os.makedirs(OUT, exist_ok=True)

env = Environment(loader=FileSystemLoader(BASE))
env.filters.setdefault("tojson", lambda v: json.dumps(v))

def make_cpu_data(nprocs=350):
    procs = [
        {
            "proc_pid": str(1000 + i),
            "proc_cpu": round((i % 50) * 0.13, 2),
            "proc_cmd": f"/usr/bin/example-daemon-{i} --worker",
            "cgroup_name": "/example.slice",
            "scaled_core_usage": [round((i % 4) * 0.25, 2)] * 4,
        }
        for i in range(nprocs)
    ]
    return {
        "ps_auxwwwm": {
            "cgroup_version": "cgroup",
            "cgroup_data": {
                "example.slice": {
                    "cpu.cfs_quota_us": "-1",
                    "cpu.cfs_period_us": "100000",
                    "cpuacct.usage_percpu": [25.0, 25.0, 25.0, 25.0],
                    "cpuset.cpus": "0-3",
                    "_processes": procs,
                }
            },
            "total_core_usage": [10.0, 10.0, 10.0, 10.0],
        }
    }

def make_mem_data(nprocs=350):
    procs = [
        {
            "proc_pid": str(1000 + i),
            "proc_mem": round((i % 30) * 0.11, 2),
            "proc_cmd": f"/usr/bin/example-daemon-{i} --worker",
            "cgroup_name": "/example.slice",
        }
        for i in range(nprocs)
    ]
    return {
        "ps_auxwwwm": {
            "cgroup_data": {
                "example.slice": {
                    "memory.usage_in_bytes": 104857600,
                    "memory.limit_in_bytes": 0,
                    "_processes": procs,
                }
            }
        },
        "free_memory": {"total": 16000, "used": 8000, "free": 4000,
                        "available": 6000, "buff_cache": 3000, "shared": 1000},
    }

for tpl, data, out in [
    ("tabs/sosreport_cgroups_cpu.html", make_cpu_data(), "rendered_cpu.html"),
    ("tabs/sosreport_cgroups_memory.html", make_mem_data(), "rendered_memory.html"),
]:
    html = env.get_template(tpl).render(data=data, directory="/tmp/example")
    with open(os.path.join(OUT, out), "w") as f:
        f.write(html)
    print(f"rendered {tpl} -> {out} ({len(html)} bytes)")
