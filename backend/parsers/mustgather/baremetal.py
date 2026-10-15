import os
import re
import fnmatch

from parsers.mustgather._common import resolve_data_dir


def parse(directory):
    result = {}

    directory = resolve_data_dir(directory)

    return result