import os
import re
import fnmatch

from parsers.mustgather._common import resolve_data_dir


def parse(directory):
    result = {}

    directory = resolve_data_dir(directory)

    return result


def findings(directory):
    from parsers.findings import no_data
    return [no_data('No bare-metal hosts in this must-gather', ['namespaces/openshift-machine-api/metal3.io/baremetalhosts'], 'not a bare-metal (metal3) platform, or the resources were not gathered')]
