/** Default layouts of the fixed FFmpeg 9.0.2 reference; no arbitrary-layout inference. */
export interface DefaultChannelLayout {readonly channels:number;readonly name:string;readonly mask:bigint}
const rows:readonly (readonly [number,string,bigint])[]=[
 [1,'mono',4n],[2,'stereo',3n],[3,'2.1',11n],[4,'4.0',263n],
 [5,'5.0',55n],[6,'5.1',63n],[7,'6.1',1807n],[8,'7.1',1599n],
 [10,'5.1.4',185871n],[12,'7.1.4',185919n],[14,'9.1.4',186111n],
 [16,'9.1.6',206158616319n],[24,'22.2',2164663779327n]
];
const layouts=new Map(rows.map(([channels,name,mask])=>[channels,Object.freeze({channels,name,mask})]));
export function defaultChannelLayout(channels:number):Readonly<DefaultChannelLayout>|null{return layouts.get(channels)??null;}
