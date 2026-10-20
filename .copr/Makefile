# COPR's "make_srpm" source method runs `make -f .copr/Makefile srpm
# outdir=<dir> spec=<spec>` in the checkout it made of the public repository
# (copr.fedorainfracloud.org/coprs/robincernin/jacarium). The SRPM comes
# from packaging/copr/make-srpm.sh, versioned by the checkout's git tag.
# (This file is a dot-path: scripts/export-source.sh lists it among the
# exported dot-files so the public clone carries it.)
srpm:
	bash packaging/copr/make-srpm.sh --outdir "$(outdir)"
