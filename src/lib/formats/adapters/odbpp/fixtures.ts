import type { AdapterFixture } from '../../fixture';
import { compressZ, rooted, tarOf, tgzOf, writeJob, zipOf } from '../../odbpp-fixture';

// One synthetic product model (original, written from the structure of the public ODB++ design format specification) in every container.
const job = writeJob();
const inFolder = rooted(job, 'odb/');
const fixtures: AdapterFixture[] = [
  { label: 'product model in a gzip tar (.tgz)', name: 'job.tgz', data: tgzOf(inFolder) },
  { label: 'product model in a gzip tar named .tar.gz', name: 'job.tar.gz', data: tgzOf(job) },
  { label: 'product model in a ZIP', name: 'job.zip', data: zipOf(inFolder) },
  { label: 'product model in a plain tar', name: 'job.tar', data: tarOf(inFolder) },
  { label: 'product model in a compress(1) tar (.tar.Z)', name: 'job.tar.z', data: compressZ(tarOf(inFolder)) },
];
export default fixtures;
