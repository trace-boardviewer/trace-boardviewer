import { lines, type AdapterFixture } from '../../fixture';

const GENCAD = ['$HEADER', 'GENCAD 1.4', 'UNITS MM', 'ORIGIN 0 0', '$ENDHEADER', '$BOARD', 'RECTANGLE 0 0 40 30', '$ENDBOARD', '$PADS', 'PAD P ROUND -1', 'CIRCLE 0 0 0.2', '$ENDPADS',
  '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS', '$SHAPES', 'SHAPE S', 'RECTANGLE -2 -1 4 2', 'PIN 1 PS -1 0 TOP 0 0', 'PIN 2 PS 1 0 TOP 0 0', '$ENDSHAPES',
  '$COMPONENTS', 'COMPONENT R1', 'PLACE 10 20', 'LAYER TOP', 'ROTATION 0', 'SHAPE S 0 0', 'DEVICE D', '$ENDCOMPONENTS', '$DEVICES', 'DEVICE D', 'VALUE "10 kOhm"', '$ENDDEVICES',
  '$SIGNALS', 'SIGNAL GND', 'NODE R1 1', '$ENDSIGNALS'];

const fixtures: AdapterFixture[] = [
  { label: 'GenCAD 1.4 board', name: 'board.cad', data: lines(GENCAD) },
  { label: 'comment line before $HEADER, CRLF', name: 'board.gcd', data: lines(['# exported', ...GENCAD], '\r\n') },
];
export default fixtures;
