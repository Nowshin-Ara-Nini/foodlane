export function verificationFields(form:FormData){
function text(name:string,label:string,max:number){const value=form.get(name);if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw Error(`Please enter a valid ${label}.`);return value.trim()}
function coordinate(name:string,label:string,min:number,max:number){const raw=text(name,label,50),n=Number(raw);if(!Number.isFinite(n)||n<min||n>max)throw Error(`Please enter a valid ${label}.`);return n}
const legalName=text('legalName','full name',120),age=Number(text('age','age',3));if(!Number.isInteger(age)||age<18||age>120)throw Error('Seller applicants must be at least 18 years old. Enter your age in whole years, between 18 and 120.');
const gender=text('gender','gender',30);if(!['Female','Male','Other','Prefer not to say'].includes(gender))throw Error('Please select a valid gender option.');
const personalEmail=text('personalEmail','personal email',254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personalEmail))throw Error('Please enter a valid personal email.');
const personalPhone=text('personalPhone','personal phone number',30);if(!/^\+?[0-9 ()-]+$/.test(personalPhone)||personalPhone.replace(/\D/g,'').length<7||personalPhone.replace(/\D/g,'').length>15)throw Error('Please enter a valid personal phone number.');
const nidNumber=text('nidNumber','NID number',30).replace(/[০-৯]/g,d=>String('০১২৩৪৫৬৭৮৯'.indexOf(d)));if(!/^[0-9]+$/.test(nidNumber))throw Error('Enter your NID number using digits only.');
return {legalName,age,gender,personalEmail,personalPhone,nidNumber,homeAddress:text('homeAddress','home address',700),placeAddress:text('placeAddress','selling-place address',500),placeLat:coordinate('placeLat','selling-place latitude',-90,90),placeLng:coordinate('placeLng','selling-place longitude',-180,180),note:text('note','selling setup description',1000)};
}
