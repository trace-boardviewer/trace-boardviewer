import { lines, type AdapterFixture } from '../../fixture';

const ASCII = [
  '|RECORD=Board|FILENAME=synthetic.PcbDoc|KIND=Protel_Advanced_PCB|VERSION=5.01|VX0=0mil|VY0=0mil|KIND0=0|VX1=3000mil|VY1=0mil|KIND1=0|VX2=3000mil|VY2=2000mil|KIND2=0|VX3=0mil|VY3=2000mil|KIND3=0',
  '|RECORD=Net|NAME=GND',
  '|RECORD=Component|LAYER=TOP|X=1000mil|Y=2000mil|ROTATION=90.000|PATTERN=QFN16|SOURCEDESIGNATOR=U1',
  '|RECORD=Pad|NAME=1|COMPONENT=0|NET=0|LAYER=TOP|X=950mil|Y=2000mil|XSIZE=60mil|YSIZE=40mil|SHAPE=RECTANGLE|ROTATION=0',
];

// The binary (compound file) variant needs a CFB writer; altium.test.ts builds it with the cfb development dependency.
const fixtures: AdapterFixture[] = [{ label: 'ASCII |RECORD= lines', name: 'board.pcbdoc', data: lines(ASCII, '\r\n') }];
export default fixtures;
