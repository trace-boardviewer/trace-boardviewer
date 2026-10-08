import { utf8, type AdapterFixture } from '../../fixture';

const LAYERS = '<layers><layer number="1" name="Top" color="4" fill="1" visible="yes" active="yes"/><layer number="16" name="Bottom" color="1" fill="1" visible="yes" active="yes"/><layer number="20" name="Dimension" color="15" fill="1" visible="yes" active="yes"/></layers>';
const wire = (x1: number, y1: number, x2: number, y2: number) => `<wire x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" width="0" layer="20"/>`;
const BOARD = `<eagle version="9.6.2"><drawing><settings><setting alwaysvectorfont="no"/></settings>${LAYERS}<board><plain>${wire(0, 0, 40, 0)}${wire(40, 0, 40, 30)}${wire(40, 30, 0, 30)}${wire(0, 30, 0, 0)}</plain>`
  + '<libraries><library name="lib"><packages><package name="R0603"><smd name="1" x="-1" y="0" dx="1" dy="1" layer="1"/><smd name="2" x="1" y="0" dx="1" dy="1" layer="1"/></package></packages></library></libraries>'
  + '<elements><element name="R1" library="lib" package="R0603" value="10k" x="10" y="20"/></elements><signals><signal name="GND" class="0"><contactref element="R1" pad="1"/></signal></signals></board></drawing></eagle>';

const fixtures: AdapterFixture[] = [
  { label: 'declaration and DOCTYPE', name: 'board.brd', data: utf8(`<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n${BOARD}\n`) },
  { label: 'bare root', name: 'board.brd', data: utf8(`${BOARD}\n`) },
];
export default fixtures;
