Open more Honhan BDV and Landrex/TestLink BRD exports: BDV now reads the optional outline-radius column, blank or comma-separated probe lists with wrapped continuation rows, spaced net names and virtual nail annotations. Non-zero outline radii are disclosed as straight segments. Shortened BDV headers and BOM-marked UTF-16 text also open.

Landrex BRD accepts the two extra numeric header fields found in real exports and test points with no net. Coordinates retain their original interpretation. Samsung CAD now includes the N_VIA test points under their preceding NET, on the correct side; generated via labels are kept out of persistent notes identities.

Checked by the maintainer on real exports of these three formats. The files remain outside the repository; regression fixtures are original synthetic examples. These checks establish compatibility with the selected exports, not every vendor variant. Existing OpenBoardView MIT attribution is retained.
