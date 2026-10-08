import { utf8 } from '../../fixture';
export const farcFixture = `:SECTION FABMASTER 1
{ FARC ASCII File - V8.F.2 - }
:EOSECTION
:SECTION FORMAT 1
((TRACK 1[]((0 0)(2000 0)(2000 2000)(0 2000)(0 0))))
:EOSECTION
:SECTION PARTS 1
2((1"J_TEST"("CONNECTOR|test"0 0 0[]())("TEST" "TEST"[]())1000 1000 900[]0 0 0 0 0 0 0)
(2"R_TEST"("RESISTOR|1K"0 0 0[]())("TEST" "TEST"[]())1500 1000 0[BOTTOM SELECTED]0 0 0 0 0 0 0))
:EOSECTION
:SECTION NETS 1
2((1 1"SYNTHETIC_NET"1[]((1 1)(2 1)))(2 2"NC_TEST"2[NCPINS]((1 2))))
:EOSECTION
:SECTION PACKAGE 1
(("TEST.OTL"(0 0 100 100 0 0)(0 0 100 100)((1 0 0"A"[TOP])(2 100 0"B"[TOP]))()()))
:EOSECTION
:SECTION FABXYDATA 1
4(2 3 0 0 0 2[]0 1()()-1 -1)
((1000 1000 1 1 1 TPIN 0 11 0[]()1 0 0 TPIN 0 0 0 0 0 0 0 1)
(1000 1100 2 1 2 DPIN 0 12 0[]()2 0 0 DPIN 0 0 0 0 0 0 0 0)
(1500 1000 1 2 1 BPIN 0 13 0[]()1 0 0 BPIN 0 0 0 0 0 0 0 2)
(500 500 1 0 0 DVIA 0 14 0[TPOINT]()1 0 0 DVIA 0 0 0 0 0 0 0 0))
()()()()
:EOSECTION
:SECTION EOARCHIVE 1
0
:EOSECTION
`;
export default [{ label: 'original two-sided job with a through-pin and via', name: 'synthetic.far', data: utf8(farcFixture) }];
