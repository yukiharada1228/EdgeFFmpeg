export function clockUnitCases(){
 const samples:string[]=[];for(const suffix of ['y','z','a','f','p','n','u','m','c','d','h','k','K','M','G','T','P','E','Z','Y'])for(const number of ['1','2.5','0.04'])for(const tail of ['', 'i','B','iB'])samples.push(`${number}${suffix}${tail}`);
 samples.push('1/infk','-infdB','1/(-infdB)','1/infdB','1/infKiB','1B','1Ki/1k','1MiB/1MB','1E/1E','1e-3m','0dB','6dB','-3dB','-(3dB)','--3dB','-(-3dB)','1/-3dB','-3dB^2','2^-3dB');
 for(let quarter=-480;quarter<=720;quarter++)samples.push(`${quarter/4}dB`);
 return samples;
}
export function hexClockCases(){const samples=clockUnitCases();for(const mantissa of ['1','1.8','.8','a.f','fffffffffffffffff','1.00000000000008','1.00000000000018'])for(const exponent of ['', 'p0','p-4','p4','p-1074','p1024'])for(const sign of ['','-','+','--','+-'])for(const suffix of ['','dB','k'])samples.push(`${sign}0x${mantissa}${exponent}${suffix}`);for(const atom of ['NaN','nan','0/0','-0','0','inf','-inf','1/NaN','NaN/0','1/(0/0)'])for(const form of ['1/($)','1/(1/($))','0/($)','($)/0','($)*0','1/(($)+1)'])samples.push(form.replace('$',atom));return samples;}
