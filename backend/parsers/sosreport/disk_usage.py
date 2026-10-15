import os
import re
import fnmatch


def parse(directory):
    result = {}

    def parse_df(path):
        try:
            with open(path, 'r') as f:
                lines = f.readlines()
        except Exception:
            return []

        df_data = []
        headers = []
        header_mapping = {
            'Filesystem': 'filesystem',
            '1K-blocks': 'size',
            'Used': 'used',
            'Available': 'available',
            'Use%': 'used_percent',
            'Mounted': 'mounted'
        }

        for i, line in enumerate(lines):
            if i == 0:
                headers = line.strip().split()
                headers = [header_mapping.get(header, header) for header in headers]
                continue
            parts = line.strip().split()
            if len(parts) < 6:
                continue
            if len(parts) > len(headers):
                parts = [parts[0]] + parts[1 - len(headers):]

            entry = dict(zip(headers, parts))
            df_data.append(entry)
        return df_data


    entries = os.listdir(directory)
    if len(entries) == 1:
        inner = os.path.join(directory, entries[0])
        if os.path.isdir(inner):
            directory = inner

    result['df'] = {'df': parse_df(os.path.join(directory, 'df'))}

    return result