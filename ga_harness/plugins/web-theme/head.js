/* Runs before first paint so a remembered theme never flashes. */
try{var t=localStorage.getItem('gah-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}
