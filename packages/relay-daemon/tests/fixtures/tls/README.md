These are public, test-only credentials for the localhost TLS transport test.
They are not used by the daemon or included in the computer installer bundle.
The self-signed certificate has a localhost SAN; tests trust it explicitly in
an isolated child process and also verify rejection without that trust.
