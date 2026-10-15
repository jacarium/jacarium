import os
import yaml
import glob
from datetime import datetime, timezone

from parsers.mustgather._common import resolve_data_dir

def parse(directory):
    result = []

    # Get collection timestamp from must-gather
    original_directory = directory
    timestamp_file = os.path.join(original_directory, "timestamp")
    collection_time = None

    if os.path.exists(timestamp_file):
        try:
            with open(timestamp_file, 'r') as f:
                lines = f.readlines()
                if len(lines) >= 1:
                    # Parse first line: "2026-04-13 14:02:58.640004158 -0700 PDT m=+0.146292020"
                    first_line = lines[0].strip()

                    # Extract datetime and timezone: "2026-04-13 14:02:58.640004158 -0700"
                    import re
                    datetime_match = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.?\d* ([+-]\d{4})', first_line)
                    if datetime_match:
                        dt_str = datetime_match.group(1)  # "2026-04-13 14:02:58"
                        tz_str = datetime_match.group(2)  # "-0700"

                        # Parse timezone offset
                        tz_sign = 1 if tz_str[0] == '+' else -1
                        tz_hours = int(tz_str[1:3])  # "07"
                        tz_minutes = int(tz_str[3:5])  # "00"
                        from datetime import timedelta
                        tz_offset = timedelta(hours=tz_sign * tz_hours, minutes=tz_sign * tz_minutes)

                        # Parse datetime as naive, then convert to UTC
                        naive_dt = datetime.fromisoformat(dt_str.replace(' ', 'T'))
                        # The local time minus the offset gives UTC
                        # e.g., 14:02 PDT (-0700) -> 14:02 - (-7 hours) = 21:02 UTC
                        collection_time = naive_dt.replace(tzinfo=timezone.utc) - tz_offset
        except Exception as e:
            import traceback
            print(f"Error parsing timestamp: {e}")
            traceback.print_exc()

    # If we couldn't get collection time, fall back to current time
    if not collection_time:
        collection_time = datetime.now(timezone.utc)

    directory = resolve_data_dir(directory)

    # Look for namespaces/*/core/secrets.yaml files
    namespaces_path = os.path.join(directory, "namespaces")

    if not os.path.exists(namespaces_path):
        return result

    # Find all secrets.yaml files
    secrets_files = glob.glob(os.path.join(namespaces_path, "*", "core", "secrets.yaml"))

    current_time = collection_time
    sixty_days_seconds = 60 * 24 * 3600

    for filepath in secrets_files:
        try:
            with open(filepath, "r") as f:
                data = yaml.safe_load(f)

            if not data:
                continue

            # Handle SecretList
            items = []
            if data.get("kind") == "SecretList" and "items" in data:
                items = data["items"]
            elif data.get("kind") == "Secret":
                items = [data]

            for secret in items:
                if not secret:
                    continue

                metadata = secret.get("metadata", {})
                annotations = metadata.get("annotations", {})

                # Only process secrets with certificate expiry annotation
                expiry_str = annotations.get("auth.openshift.io/certificate-not-after")
                if not expiry_str:
                    continue

                try:
                    # Parse ISO 8601 format: 2026-06-10T20:19:26Z
                    expiry_time = datetime.fromisoformat(expiry_str.replace('Z', '+00:00'))

                    # Calculate time difference
                    time_diff = expiry_time - current_time
                    days_left = time_diff.total_seconds() / 86400

                    # Determine status
                    if days_left < 0:
                        status = "Expired"
                        days_ago = abs(int(days_left))
                        days_display = f"{days_ago} days ago"
                    elif days_left <= 60:
                        status = "Expiring Soon"
                        days_display = f"{int(days_left)} days left"
                    else:
                        status = "Valid"
                        days_display = f"{int(days_left)} days left"

                    result.append({
                        "namespace": metadata.get("namespace", ""),
                        "name": metadata.get("name", ""),
                        "type": secret.get("type", ""),
                        "expiry": expiry_str,
                        "expiry_timestamp": expiry_time.isoformat(),
                        "days_left": days_left,
                        "days_display": days_display,
                        "status": status,
                        "created": metadata.get("creationTimestamp", ""),
                        "annotations": annotations,
                        "raw": secret
                    })

                except Exception as e:
                    # Skip secrets with invalid date format
                    continue

        except Exception as e:
            result.append({"error": str(e), "file": filepath})

    return result
