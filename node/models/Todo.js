import mongoose from "mongoose";
const CompanySchema=new mongoose.Schema(
    {
        Name:String,
        Salary:Number,
        Language:String,
        City:String ,
        isManager:Boolean

    }
);
export const Company=mongoose.model('Company',CompanySchema)